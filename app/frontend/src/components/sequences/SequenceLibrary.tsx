import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { SequenceLibraryItem, SequenceInput } from '../../types'
import { SAMPLE_SEQUENCES } from '../../types'
import { useRole } from '../../contexts/RoleContext'
import { listEncryptedSequences } from '../../services/s3'
import { fetchAuthSession } from 'aws-amplify/auth'
import { notify, confirmAction } from '../../services/notify'

export function SequenceLibrary() {
  const { t } = useTranslation()
  const [sequences, setSequences] = useState<SequenceLibraryItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [showInputModal, setShowInputModal] = useState(false)
  const [newSequence, setNewSequence] = useState<SequenceInput>({
    name: '',
    sequence: '',
    type: 'protein',
  })
  const [isEncrypting, setIsEncrypting] = useState(false)
  const [selectedSequence, setSelectedSequence] = useState<SequenceLibraryItem | null>(null)
  const { role } = useRole()

  // Load sequences from S3
  const loadSequences = async () => {
    if (!role) {
      console.warn('No role selected')
      return
    }

    setIsLoading(true)
    
    try {
      // Get user ID from session
      const session = await fetchAuthSession()
      const userId = session.identityId || 'unknown'
      
      // List sequences from S3
      let s3Sequences: { key: string; name: string; lastModified: Date }[] = []
      try {
        s3Sequences = await listEncryptedSequences(role, userId)
      } catch (e) {
        console.warn('Could not load sequences from S3:', e)
      }
      
      // Convert to SequenceLibraryItem format
      const items: SequenceLibraryItem[] = s3Sequences.map(seq => ({
        id: seq.key,
        name: seq.name,
        sequence: '[Encrypted]',
        length: 0, // Will be populated from metadata
        type: 'protein' as const,
        encrypted: true,
        s3_key: seq.key,
        created_at: seq.lastModified.toISOString(),
      }))
      
      setSequences(items)
    } catch (err) {
      console.error('Failed to load sequences:', err)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadSequences()
  }, [])

  // Validate amino acid sequence
  const validateSequence = (seq: string): { valid: boolean; error?: string } => {
    const cleanSeq = seq.replace(/\s+/g, '').toUpperCase()
    
    if (cleanSeq.length < 10) {
      return { valid: false, error: t('sequences.library.errorMinLength') }
    }

    if (cleanSeq.length > 2048) {
      return { valid: false, error: t('sequences.library.errorMaxLength') }
    }

    const validAminoAcids = /^[ACDEFGHIKLMNPQRSTVWY]+$/
    if (!validAminoAcids.test(cleanSeq)) {
      return { valid: false, error: t('sequences.library.errorInvalidChars') }
    }
    
    return { valid: true }
  }

  // Encrypt and store sequence
  const encryptAndStore = async () => {
    const validation = validateSequence(newSequence.sequence)
    if (!validation.valid) {
      notify(validation.error ?? t('sequences.library.errorInvalidSequence'))
      return
    }

    setIsEncrypting(true)
    try {
      // TODO: Implement actual KMS encryption and S3 storage
      // 1. Get KMS key from environment
      // 2. Encrypt sequence data using KMS
      // 3. Store encrypted data in S3
      // 4. Save metadata
      
      console.log('Would encrypt and store:', newSequence)
      
      // Placeholder: Add to local list
      const newItem: SequenceLibraryItem = {
        id: crypto.randomUUID(),
        name: newSequence.name || t('sequences.library.unnamedSequence'),
        sequence: newSequence.sequence.replace(/\s+/g, ''),
        length: newSequence.sequence.replace(/\s+/g, '').length,
        type: newSequence.type,
        encrypted: true,
        created_at: new Date().toISOString(),
        s3_key: `sequences/${crypto.randomUUID()}.enc`,
        kms_key_id: 'placeholder-kms-key-id',
      }
      
      setSequences(prev => [newItem, ...prev])
      setShowInputModal(false)
      setNewSequence({ name: '', sequence: '', type: 'protein' })
      
      notify(t('sequences.library.notifyStored'))
    } catch (error) {
      console.error('Failed to encrypt and store:', error)
      notify(t('sequences.library.notifyStoreFailed'))
    } finally {
      setIsEncrypting(false)
    }
  }

  // Load sample sequence
  const loadSample = (key: string) => {
    const sample = SAMPLE_SEQUENCES[key]
    if (sample) {
      setNewSequence({
        name: sample.name,
        sequence: sample.sequence,
        type: sample.type,
      })
    }
  }

  // Delete sequence
  const deleteSequence = async (id: string) => {
    if (!confirmAction(t('sequences.library.confirmDelete'))) return
    
    try {
      // TODO: Delete from S3
      setSequences(prev => prev.filter(s => s.id !== id))
    } catch (error) {
      console.error('Failed to delete sequence:', error)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('sequences.library.title')}</h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">
            {t('sequences.library.subtitle')}
          </p>
        </div>
        <button onClick={() => setShowInputModal(true)} className="btn btn-primary">
          <span>➕</span>
          {t('sequences.library.addSequence')}
        </button>
      </div>

      {/* Info Card */}
      <div className="card bg-blue-50 dark:bg-blue-900 border-blue-200 dark:border-blue-800">
        <div className="flex items-start gap-3">
          <span className="text-2xl">🔐</span>
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">{t('sequences.library.encryptionTitle')}</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {t('sequences.library.encryptionDescription')}
            </p>
          </div>
        </div>
      </div>

      {/* Sequence List */}
      <div className="card">
        <div className="card-header">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('sequences.library.yourSequences')}</h2>
          <button onClick={loadSequences} className="btn btn-secondary btn-small" disabled={isLoading}>
            {isLoading ? <span className="spinner-small"></span> : '🔄'} {t('sequences.library.refresh')}
          </button>
        </div>

        {isLoading ? (
          <div className="text-center py-12">
            <div className="spinner mx-auto mb-4"></div>
            <p className="text-gray-500 dark:text-gray-400">{t('sequences.library.loading')}</p>
          </div>
        ) : sequences.length === 0 ? (
          <div className="text-center py-12">
            <span className="text-4xl mb-4 block">🧬</span>
            <p className="text-gray-500 dark:text-gray-400 mb-4">{t('sequences.library.emptyState')}</p>
            <button onClick={() => setShowInputModal(true)} className="btn btn-primary">
              {t('sequences.library.addFirstSequence')}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {sequences.map(seq => (
              <div 
                key={seq.id} 
                className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                  selectedSequence?.id === seq.id 
                    ? 'border-primary-500 bg-primary-50' 
                    : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                }`}
                onClick={() => setSelectedSequence(seq)}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-medium text-gray-900 dark:text-gray-100">{seq.name}</h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {t('sequences.library.sequenceMeta', {
                        length: seq.length,
                        type: seq.type,
                        date: new Date(seq.created_at).toLocaleDateString(),
                      })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="badge badge-success">{t('sequences.library.encryptedBadge')}</span>
                    <button 
                      onClick={(e) => { e.stopPropagation(); deleteSequence(seq.id); }}
                      className="text-red-500 hover:text-red-700 p-1"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Input Modal */}
      {showInputModal && (
        <div className="modal-overlay" onClick={() => setShowInputModal(false)}>
          <div className="modal-content max-w-2xl" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="text-lg font-semibold">{t('sequences.library.modalTitle')}</h2>
              <button onClick={() => setShowInputModal(false)} className="text-gray-400 hover:text-gray-600">
                ✕
              </button>
            </div>
            <div className="modal-body space-y-4">
              {/* Name Input */}
              <div>
                <label className="label">{t('sequences.library.nameLabel')}</label>
                <input
                  type="text"
                  className="input"
                  placeholder={t('sequences.library.namePlaceholder')}
                  value={newSequence.name}
                  onChange={e => setNewSequence(prev => ({ ...prev, name: e.target.value }))}
                />
              </div>

              {/* Sample Loader */}
              <div>
                <label className="label">{t('sequences.library.loadSampleLabel')}</label>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(SAMPLE_SEQUENCES).map(([key, sample]) => (
                    <button
                      key={key}
                      onClick={() => loadSample(key)}
                      className="btn btn-secondary btn-small"
                    >
                      {sample.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Sequence Input */}
              <div>
                <label className="label">
                  {t('sequences.library.sequenceLabel')} <span className="text-red-500">*</span>
                </label>
                <textarea
                  className="input h-40 font-mono text-sm"
                  placeholder={t('sequences.library.sequencePlaceholder')}
                  value={newSequence.sequence}
                  onChange={e => setNewSequence(prev => ({ ...prev, sequence: e.target.value }))}
                />
                <div className="flex justify-between mt-1 text-sm text-gray-500 dark:text-gray-400">
                  <span>
                    {t('sequences.library.residueCount', {
                      length: newSequence.sequence.replace(/\s+/g, '').length,
                    })}
                  </span>
                  <span>{t('sequences.library.maxResidues')}</span>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowInputModal(false)} className="btn btn-secondary">
                {t('sequences.library.cancel')}
              </button>
              <button 
                onClick={encryptAndStore} 
                disabled={isEncrypting || !newSequence.sequence.trim()}
                className="btn btn-primary"
              >
                {isEncrypting ? (
                  <>
                    <span className="spinner-small"></span>
                    {t('sequences.library.encrypting')}
                  </>
                ) : (
                  <>
                    <span>🔐</span>
                    {t('sequences.library.encryptAndStore')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}