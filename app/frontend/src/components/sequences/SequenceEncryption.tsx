import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthProvider'
import { useRole } from '../../contexts/RoleContext'
import { encryptWithContext } from '../../services/kms'
import { uploadEncryptedSequence, listEncryptedSequences, deleteEncryptedData } from '../../services/s3'
import type { SequenceInput } from '../../types'
import { SAMPLE_SEQUENCES } from '../../types'
import { notify, confirmAction } from '../../services/notify'

interface StoredSeq {
  key: string
  name: string
  lastModified: Date
}

interface SequenceEncryptionProps {
  onEncrypted?: (s3Key: string) => void
  onSubmitJob?: (encryptedSequence: string, s3Key: string, context: Record<string, string>) => void
}

export function SequenceEncryption({ onEncrypted, onSubmitJob }: SequenceEncryptionProps) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { roleConfig } = useRole()

  const [sequence, setSequence] = useState<SequenceInput>({
    name: '',
    sequence: '',
    type: 'protein',
  })
  const [isEncrypting, setIsEncrypting] = useState(false)
  const [encryptionResult, setEncryptionResult] = useState<{
    ciphertext: string
    s3Key: string
    context: Record<string, string>
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)

  // Already-encrypted sequences in S3 for this user.
  const [stored, setStored] = useState<StoredSeq[]>([])
  const [isLoadingStored, setIsLoadingStored] = useState(false)

  const kmsKeyAlias = roleConfig?.kmsKeyAlias || 'alias/boltz-sequence-key'

  // List this user's encrypted sequences. Must list under the SAME identifier used at
  // upload time (user.sub), or the prefix won't match and nothing shows.
  const loadStored = useCallback(async () => {
    if (!user?.sub) return
    setIsLoadingStored(true)
    try {
      const items = await listEncryptedSequences('biologist', user.sub)
      setStored(items.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime()))
    } catch (e) {
      console.warn('Could not list encrypted sequences:', e)
    } finally {
      setIsLoadingStored(false)
    }
  }, [user?.sub])

  useEffect(() => {
    loadStored()
  }, [loadStored])

  const deleteStored = async (key: string) => {
    if (!confirmAction(t('sequences.encryption.confirmDeleteSequence'))) return
    try {
      await deleteEncryptedData(key)
      setStored(prev => prev.filter(s => s.key !== key))
    } catch (e) {
      notify(t('sequences.encryption.failedToDelete', { error: e instanceof Error ? e.message : t('sequences.encryption.unknownError') }))
    }
  }

  // Validate sequence
  const validateSequence = (seq: string): { valid: boolean; error?: string } => {
    const cleanSeq = seq.replace(/\s+/g, '').toUpperCase()

    if (cleanSeq.length < 10) {
      return { valid: false, error: t('sequences.encryption.sequenceMinLength') }
    }

    if (cleanSeq.length > 2048) {
      return { valid: false, error: t('sequences.encryption.sequenceMaxLength') }
    }

    const validAminoAcids = /^[ACDEFGHIKLMNPQRSTVWY]+$/
    if (!validAminoAcids.test(cleanSeq)) {
      const invalidChars = cleanSeq.split('').filter(c => !/[ACDEFGHIKLMNPQRSTVWY]/.test(c))
      return {
        valid: false,
        error: t('sequences.encryption.invalidCharacters', { chars: [...new Set(invalidChars)].join(', ') })
      }
    }

    return { valid: true }
  }

  // Handle sequence change with validation
  const handleSequenceChange = (value: string) => {
    setSequence(prev => ({ ...prev, sequence: value }))
    setEncryptionResult(null)

    if (value.trim()) {
      const validation = validateSequence(value)
      setValidationError(validation.valid ? null : validation.error || null)
    } else {
      setValidationError(null)
    }
  }

  // Load sample sequence
  const loadSample = (key: string) => {
    const sample = SAMPLE_SEQUENCES[key]
    if (sample) {
      setSequence({
        name: sample.name,
        sequence: sample.sequence,
        type: sample.type,
      })
      setValidationError(null)
      setEncryptionResult(null)
    }
  }

  // Encrypt sequence
  const handleEncrypt = async () => {
    const validation = validateSequence(sequence.sequence)
    if (!validation.valid) {
      setError(validation.error || t('sequences.encryption.invalidSequence'))
      return
    }

    if (!user?.sub) {
      setError(t('sequences.encryption.userNotAuthenticated'))
      return
    }

    setIsEncrypting(true)
    setError(null)

    try {
      const cleanSequence = sequence.sequence.replace(/\s+/g, '').toUpperCase()
      const sequenceId = crypto.randomUUID()

      // Create encryption context
      // NOTE: 'application' is REQUIRED for IAM policy condition
      const encryptionContext = {
        application: 'boltz-protein-folding',  // Required for IAM policy
        purpose: 'protein-structure-prediction',
        sequence_id: sequenceId,
        sequence_name: sequence.name || 'unnamed',
        sequence_length: cleanSequence.length.toString(),
        user_id: user.sub,
        timestamp: new Date().toISOString(),
      }

      // Encrypt with KMS
      const { ciphertext, context } = await encryptWithContext(
        kmsKeyAlias,
        cleanSequence,
        encryptionContext
      )

      // Upload to S3, persisting the encryption context so it can be reconstructed
      // for KMS decryption at prediction time (decrypt requires the exact context).
      const s3Key = await uploadEncryptedSequence(
        'biologist',
        user.sub,
        sequenceId,
        ciphertext,
        {
          name: sequence.name || 'unnamed',
          length: cleanSequence.length,
          kmsKeyId: kmsKeyAlias,
          encryptionContext: context,
        }
      )

      setEncryptionResult({
        ciphertext,
        s3Key,
        context,
      })

      onEncrypted?.(s3Key)
      loadStored()  // reflect the newly uploaded sequence immediately
    } catch (err) {
      setError(err instanceof Error ? err.message : t('sequences.encryption.encryptionFailed'))
    } finally {
      setIsEncrypting(false)
    }
  }

  // Submit job with encrypted sequence
  const handleSubmitJob = () => {
    if (encryptionResult) {
      onSubmitJob?.(
        encryptionResult.ciphertext,
        encryptionResult.s3Key,
        encryptionResult.context
      )
    }
  }

  const cleanSequence = sequence.sequence.replace(/\s+/g, '')

  return (
    <div className="space-y-6">
      {/* Sequence Input Card */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          🧬 {t('sequences.encryption.proteinSequenceTitle')}
        </h2>

        {/* Name Input */}
        <div className="mb-4">
          <label className="label">{t('sequences.encryption.sequenceNameLabel')}</label>
          <input
            type="text"
            className="input"
            placeholder={t('sequences.encryption.sequenceNamePlaceholder')}
            value={sequence.name}
            onChange={e => setSequence(prev => ({ ...prev, name: e.target.value }))}
          />
        </div>

        {/* Sample Loader */}
        <div className="mb-4">
          <label className="label">{t('sequences.encryption.loadSampleLabel')}</label>
          <div className="flex flex-wrap gap-2">
            {Object.entries(SAMPLE_SEQUENCES).map(([key, sample]) => (
              <button
                key={key}
                onClick={() => loadSample(key)}
                className="btn btn-secondary btn-sm"
              >
                {sample.name}
              </button>
            ))}
          </div>
        </div>

        {/* Sequence Textarea */}
        <div className="mb-4">
          <label className="label">
            {t('sequences.encryption.aminoAcidSequenceLabel')} <span className="text-red-500">*</span>
          </label>
          <textarea
            className={`input h-40 font-mono text-sm ${
              validationError ? 'border-red-500' : ''
            }`}
            placeholder={t('sequences.encryption.sequencePlaceholder')}
            value={sequence.sequence}
            onChange={e => handleSequenceChange(e.target.value)}
          />
          <div className="flex justify-between mt-1 text-sm">
            <span className={cleanSequence.length > 2048 ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'}>
              {cleanSequence.length} {t('sequences.encryption.residues')}
            </span>
            <span className="text-gray-500 dark:text-gray-400">{t('sequences.encryption.maxResidues')}</span>
          </div>
          {validationError && (
            <p className="text-sm text-red-500 mt-1">{validationError}</p>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {/* Encrypt Button */}
        <button
          onClick={handleEncrypt}
          disabled={isEncrypting || !sequence.sequence.trim() || !!validationError}
          className="btn btn-primary w-full"
        >
          {isEncrypting ? (
            <>
              <span className="spinner-small"></span>
              {t('sequences.encryption.encrypting')}
            </>
          ) : (
            <>
              🔐 {t('sequences.encryption.encryptButton')}
            </>
          )}
        </button>
      </div>

      {/* Your Encrypted Sequences (already uploaded to S3) */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">🔐 {t('sequences.encryption.yourEncryptedSequencesTitle')}</h2>
          <button onClick={loadStored} className="btn btn-secondary btn-sm" disabled={isLoadingStored}>
            {isLoadingStored ? <span className="spinner-small"></span> : '🔄'} {t('sequences.encryption.refresh')}
          </button>
        </div>

        {isLoadingStored ? (
          <div className="text-center py-8">
            <div className="spinner mx-auto mb-2"></div>
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('sequences.encryption.loadingFromS3')}</p>
          </div>
        ) : stored.length === 0 ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            <span className="text-3xl mb-2 block">🧬</span>
            <p className="text-sm">{t('sequences.encryption.noSequencesMessage')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
              {t('sequences.encryption.storedHelpText')}
            </p>
            {stored.map(seq => (
              <div key={seq.key} className="flex items-center justify-between p-3 border border-gray-200 dark:border-gray-700 rounded-lg">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 dark:text-gray-100 truncate">{seq.name}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate">{seq.key}</div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {t('sequences.encryption.uploaded')} {seq.lastModified.toLocaleString()}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="badge badge-success">{t('sequences.encryption.encryptedBadge')}</span>
                  <button
                    onClick={() => deleteStored(seq.key)}
                    className="text-red-500 hover:text-red-700 p-1"
                    title={t('sequences.encryption.deleteFromS3Title')}
                  >
                    🗑️
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Encryption Result */}
      {encryptionResult && (
        <div className="card bg-green-50 dark:bg-green-900 border-green-200 dark:border-green-800">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-green-600 dark:text-green-300 text-xl">✓</span>
            <h3 className="text-lg font-semibold text-green-900 dark:text-green-100">
              {t('sequences.encryption.encryptedSuccessTitle')}
            </h3>
          </div>

          <div className="space-y-3">
            <div>
              <label className="label">{t('sequences.encryption.s3KeyLabel')}</label>
              <p className="font-mono text-sm bg-white dark:bg-gray-800 p-2 rounded border border-green-200 dark:border-green-800 break-all">
                {encryptionResult.s3Key}
              </p>
            </div>

            <div>
              <label className="label">{t('sequences.encryption.encryptionContextLabel')}</label>
              <pre className="text-xs bg-white dark:bg-gray-800 p-2 rounded border border-green-200 dark:border-green-800 overflow-x-auto">
                {JSON.stringify(encryptionResult.context, null, 2)}
              </pre>
            </div>

            <div>
              <label className="label">{t('sequences.encryption.ciphertextPreviewLabel')}</label>
              <p className="font-mono text-xs bg-white dark:bg-gray-800 p-2 rounded border border-green-200 dark:border-green-800 break-all">
                {encryptionResult.ciphertext.substring(0, 100)}...
              </p>
            </div>
          </div>

          {onSubmitJob && (
            <button
              onClick={handleSubmitJob}
              className="btn btn-primary w-full mt-4"
            >
              🚀 {t('sequences.encryption.submitJobButton')}
            </button>
          )}
        </div>
      )}

      {/* Info */}
      <div className="card bg-blue-50 dark:bg-blue-900 border-blue-200 dark:border-blue-800">
        <div className="flex items-start gap-3">
          <span className="text-2xl">ℹ️</span>
          <div className="text-sm text-blue-800 dark:text-blue-200">
            <p className="font-medium mb-1">{t('sequences.encryption.howItWorksTitle')}</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>
                {t('sequences.encryption.howItWorksStep1')}{' '}
                <code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">{kmsKeyAlias}</code>
              </li>
              <li>{t('sequences.encryption.howItWorksStep2')}</li>
              <li>{t('sequences.encryption.howItWorksStep3')}</li>
              <li>{t('sequences.encryption.howItWorksStep4')}</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  )
}
