import { useState, useEffect } from 'react'
import { useRole } from '../../contexts/RoleContext'
import type { KMSKeyPolicy, PCRCondition, AttestationDocument, TrustStoreEntry } from '../../types'
import { PCR_DESCRIPTIONS, normalizePcrValues, isZeroPcr } from '../../types'
import {
  getKeyPolicy,
  getKeyMetadata,
  putKeyPolicy,
  findAttestationStatement,
  extractEnforcedPCRConditions,
  upsertAttestationStatement,
  BIOLOGIST_ATTESTATION_SID,
  BIOPHYSICIST_ATTESTATION_SID,
} from '../../services/kms'
import { getTrustStore } from '../../services/trustStore'
import { useTranslation } from 'react-i18next'

interface KMSPolicyEditorProps {
  attestation: AttestationDocument | null
  onPolicyUpdated?: () => void
}

export function KMSPolicyEditor({ attestation: rawAttestation, onPolicyUpdated }: KMSPolicyEditorProps) {
  const { role, roleConfig } = useRole()
  const { t } = useTranslation()

  // The backend keys pcr_values by bare numbers ("0"/"16"); normalize so PCR lookups
  // (pcr0/pcr16) and the PCR12=all-zeros selection resolve correctly.
  const attestation: AttestationDocument | null = rawAttestation
    ? { ...rawAttestation, pcr_values: normalizePcrValues(rawAttestation.pcr_values) }
    : null
  
  const [policy, setPolicy] = useState<KMSKeyPolicy | null>(null)
  const [keyId, setKeyId] = useState<string | null>(null)
  const [currentPCRs, setCurrentPCRs] = useState<PCRCondition[]>([])
  const [trustStore, setTrustStore] = useState<TrustStoreEntry | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  // PCR12 is intentionally included by default: it is an all-zero (unmeasured) register
  // on this platform, and binding the KMS policy to PCR12=all-zeros asserts "nothing
  // unexpected was extended here" — defense in depth alongside the measured PCRs.
  // Which PCRs each key binds:
  //  - Sequence key (biologist): PCR4/7/12 (platform + boot integrity) AND PCR16 (model
  //    hash). A sequence must decrypt only when the trusted platform AND the specific
  //    approved model are loaded; sequence decrypts happen AFTER the model is loaded, so
  //    PCR16 is meaningful and committed by then.
  //  - Model key (biophysicist): PCR4/7/12 ONLY, never PCR16. The model weights are what
  //    get measured INTO PCR16, so at model-decrypt time the model is not yet loaded and
  //    PCR16 does not reflect it. Binding the model key to PCR16 would be circular and
  //    force a fragile, per-reload re-binding; platform/boot integrity is the correct gate
  //    for releasing the weights onto a trusted instance.
  // PCR12 is all-zeros (unmeasured) here, bound as defense in depth. PCR0 (firmware) is
  // intentionally not bound by default (brittle across firmware updates); tick it manually.
  const APPLICABLE_PCRS = role === 'biologist'
    ? ['pcr4', 'pcr7', 'pcr12', 'pcr16']
    : ['pcr4', 'pcr7', 'pcr12']
  const [selectedPCRs, setSelectedPCRs] = useState<string[]>(APPLICABLE_PCRS)
  const [principalArn, setPrincipalArn] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)

  const attestationSid = role === 'biologist' ? BIOLOGIST_ATTESTATION_SID : BIOPHYSICIST_ATTESTATION_SID
  const keyAlias = roleConfig?.kmsKeyAlias || ''

  // Load current policy
  useEffect(() => {
    if (!keyAlias) return

    loadPolicy()
  }, [keyAlias])

  // Auto-load the (browser) trust store on mount so the three-way consistency check
  // (backend attestation vs trust store vs KMS policy) can render without requiring
  // the user to click "Load from Trust Store" first.
  useEffect(() => {
    if (!role) return
    const environment = import.meta.env.VITE_ENVIRONMENT || 'prod'
    const data = getTrustStore(role, environment)
    if (data) {
      data.pcr_values = normalizePcrValues(data.pcr_values)
      setTrustStore(data)
    }
  }, [role])

  // The KMS policy is scoped to the attested instance role ARN, which comes from the
  // SIGNED attestation (user_data), falling back to the (unsigned) enclave_info for older
  // backends. It is never hand-typed — that would let the principal be widened or mistyped
  // and would break the "trust is anchored in the attestation" model.
  useEffect(() => {
    const arn = attestation?.user_data || attestation?.enclave_info?.iam_role_arn
    if (arn) setPrincipalArn(arn)
  }, [attestation?.user_data, attestation?.enclave_info?.iam_role_arn])

  const loadPolicy = async () => {
    setIsLoading(true)
    setError(null)
    
    try {
      const loadedPolicy = await getKeyPolicy(keyAlias)
      setPolicy(loadedPolicy)

      // Resolve the concrete key ID behind the alias so the view can name exactly which
      // key its actions affect.
      try {
        const md = await getKeyMetadata(keyAlias)
        setKeyId(md?.KeyId ?? null)
      } catch {
        /* non-fatal: the alias is still shown */
      }
      
      // Extract existing PCR conditions from the enforcement (Deny) statements — plus a
      // legacy Allow if an older policy wrote one.
      const pcrs = extractEnforcedPCRConditions(loadedPolicy, attestationSid)
      setCurrentPCRs(pcrs)

      // Recover the EC2 role ARN from a legacy Allow statement if one still exists
      // (new Deny-only policies use Principal "*", so there is nothing to recover).
      const statement = findAttestationStatement(loadedPolicy, attestationSid)
      if (statement && statement.Effect === 'Allow' &&
          typeof statement.Principal === 'object' && 'AWS' in statement.Principal) {
        const aws = statement.Principal.AWS
        setPrincipalArn(Array.isArray(aws) ? aws[0] : aws)
      }
      
      // (Principal ARN is derived from the signed attestation in a dedicated effect.)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('kms.policy-editor.errFailedLoadPolicy'))
    } finally {
      setIsLoading(false)
    }
  }

  const togglePCR = (pcr: string) => {
    setSelectedPCRs(prev => 
      prev.includes(pcr) 
        ? prev.filter(p => p !== pcr)
        : [...prev, pcr]
    )
  }

  // Add PCR conditions from trust store
  const handleAddPCRFromTrustStore = async () => {
    if (!policy || !trustStore || !principalArn) {
      setError(t('kms.policy-editor.errMissingDataTrustStore'))
      return
    }

    setIsSaving(true)
    setError(null)
    setSuccess(null)

    try {
      // Build PCR conditions from selected PCRs in trust store
      const pcrConditions: PCRCondition[] = selectedPCRs.map(pcr => ({
        pcr,
        value: trustStore.pcr_values[pcr] || '',
        description: PCR_DESCRIPTIONS[pcr],
      })).filter(c => c.value)

      if (pcrConditions.length === 0) {
        throw new Error(t('kms.policy-editor.errNoValidPcr'))
      }

      // Update policy
      const updatedPolicy = upsertAttestationStatement(
        policy,
        attestationSid,
        principalArn,
        pcrConditions
      )

      await putKeyPolicy(keyAlias, updatedPolicy)
      
      setPolicy(updatedPolicy)
      setCurrentPCRs(pcrConditions)
      setSuccess(t('kms.policy-editor.successPolicyUpdatedTrustStore'))
      
      onPolicyUpdated?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('kms.policy-editor.errFailedUpdatePolicy'))
    } finally {
      setIsSaving(false)
    }
  }

  // ==================== Three-way PCR consistency check ====================
  // Compare, per PCR, the value from each of the three sources the biologist cares
  // about: what the BACKEND currently attests, what the TRUST STORE (their trusted
  // baseline) records, and what the KMS POLICY actually enforces for decryption. Any
  // divergence means decryption may fail or be gated on a stale/incorrect measurement.
  const policyPcrMap: Record<string, string> = {}
  for (const c of currentPCRs) policyPcrMap[c.pcr.toLowerCase()] = c.value
  const trustPcrMap = trustStore?.pcr_values || {}
  const attestPcrMap = attestation?.pcr_values || {}

  const enforcedPcrs = new Set(Object.keys(policyPcrMap))
  // Show ALL PCRs present across the three sources (trust store, live backend, current KMS
  // policy), sorted by index; each row is individually selectable. The role's default set
  // (APPLICABLE_PCRS: PCR4/7/12, plus PCR16 for the sequence key) starts checked, but the
  // operator may tick additional PCRs to bind.
  const allPcrKeys = Array.from(new Set([
    ...Object.keys(trustPcrMap),
    ...Object.keys(attestPcrMap),
    ...Object.keys(policyPcrMap),
  ])).sort((a, b) => (parseInt(a.replace('pcr', ''), 10) || 0) - (parseInt(b.replace('pcr', ''), 10) || 0))
  const pcrRows = allPcrKeys.map((pcr) => ({
    pcr,
    backend: attestPcrMap[pcr],
    trust: trustPcrMap[pcr],
    policyVal: policyPcrMap[pcr],
    inPolicy: enforcedPcrs.has(pcr),
  }))
  const short = (v?: string) => (v ? (isZeroPcr(v) ? 'all-zeros' : `${v.slice(0, 12)}…`) : '—')

  if (isLoading) {
    return (
      <div className="card">
        <div className="flex items-center justify-center py-8">
          <div className="spinner"></div>
          <span className="ml-3 text-gray-600 dark:text-gray-400">{t('kms.policy-editor.loadingPolicy')}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          🔑 {t('kms.policy-editor.title')}
        </h2>
        <button
          onClick={loadPolicy}
          className="btn btn-secondary btn-sm"
          disabled={isLoading}
        >
          {t('kms.policy-editor.refresh')}
        </button>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        {t('kms.policy-editor.intro')}
      </p>

      {/* Affected KMS key — alias + concrete key ID this view's actions modify. */}
      <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 mb-4 text-sm space-y-1">
        <div>
          <span className="text-gray-500 dark:text-gray-400">{t('kms.policy-editor.keyAliasLabel')}</span>
          <span className="ml-2 font-mono text-gray-900 dark:text-gray-100">{keyAlias}</span>
        </div>
        <div>
          <span className="text-gray-500 dark:text-gray-400">{t('kms.policy-editor.keyIdLabel', { defaultValue: 'Key ID:' })}</span>
          <span className="ml-2 font-mono text-gray-900 dark:text-gray-100">{keyId || '…'}</span>
        </div>
        <div>
          <span className="text-gray-500 dark:text-gray-400">{t('kms.policy-editor.policyStatementLabel')}</span>
          <span className="ml-2 font-mono text-gray-900 dark:text-gray-100">{attestationSid}</span>
        </div>
      </div>

      {/* Backend connection indicator */}
      {!attestation && (
        <div className="mb-4 rounded-lg border border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-900 p-3 text-sm text-yellow-800 dark:text-yellow-200">
          ⚠️ {t('kms.policy-editor.backendNotConnected', { defaultValue: 'Backend not connected — reconnect and verify it in the Backend Connection tab to see live PCR values to compare against.' })}
        </div>
      )}

      {/* One list: trust-store PCRs (the source) with checkboxes, shown alongside the live
          backend value and the value the KMS policy enforces, with deviations highlighted. */}
      {trustStore ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400">
                  <th className="py-1 pr-2"></th>
                  <th className="py-1 pr-3">{t('kms.policy-editor.colPcr')}</th>
                  <th className="py-1 pr-3">{t('kms.policy-editor.colTrustStore')}</th>
                  <th className="py-1 pr-3">{t('kms.policy-editor.colBackendLive')}</th>
                  <th className="py-1 pr-3">{t('kms.policy-editor.colKmsPolicy')}</th>
                  <th className="py-1">{t('kms.policy-editor.colStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {pcrRows.map((r) => {
                  const hasTrust = r.trust !== undefined && r.trust !== null
                  const backendMismatch = r.backend != null && r.backend !== r.trust
                  const policyMismatch = r.policyVal != null && r.policyVal !== r.trust
                  const mismatch = backendMismatch || policyMismatch
                  return (
                    <tr key={r.pcr} className={`border-t border-gray-100 dark:border-gray-700 ${mismatch ? 'bg-red-100/40 dark:bg-red-900/40' : ''}`}>
                      <td className="py-1 pr-2">
                        <input type="checkbox" className="rounded" checked={selectedPCRs.includes(r.pcr)} disabled={!hasTrust} onChange={() => togglePCR(r.pcr)} />
                      </td>
                      <td className="py-1 pr-3 font-medium">{r.pcr.toUpperCase()}</td>
                      <td className="py-1 pr-3 font-mono" title={r.trust}>{short(r.trust)}</td>
                      <td className={`py-1 pr-3 font-mono ${backendMismatch ? 'text-red-700 dark:text-red-300 font-semibold' : ''}`} title={r.backend}>{short(r.backend)}</td>
                      <td className={`py-1 pr-3 font-mono ${policyMismatch ? 'text-red-700 dark:text-red-300 font-semibold' : ''}`} title={r.policyVal}>{short(r.policyVal)}</td>
                      <td className="py-1">
                        {mismatch
                          ? <span className="badge badge-error">{t('kms.policy-editor.badgeDiffer')}</span>
                          : r.inPolicy
                          ? <span className="badge badge-success">{t('kms.policy-editor.badgeEnforced')}</span>
                          : <span className="badge badge-gray">{t('kms.policy-editor.badgeNotEnforced')}</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
            {t('kms.policy-editor.enforcedByDenyShort', { defaultValue: 'One explicit Deny per selected PCR: kms:Decrypt is denied if any is missing from the request or does not match — so the asset unseals only inside an instance presenting these exact NitroTPM measurements.' })}
          </p>

          {/* Principal ARN — read-only, from the signed attestation (never hand-typed). */}
          <div className="mt-3">
            <label className="label">{t('kms.policy-editor.ec2RoleArnLabel')}</label>
            <input
              type="text"
              readOnly
              value={principalArn}
              className="input font-mono text-xs bg-gray-100 dark:bg-gray-700 cursor-not-allowed"
              placeholder={t('kms.policy-editor.arnFromAttestation', { defaultValue: 'Populated from the verified attestation' })}
            />
          </div>

          {selectedPCRs.length === 0 && (
            <p className="text-xs text-yellow-600 dark:text-yellow-300 mt-2">⚠️ {t('kms.policy-editor.selectAtLeastOnePcr')}</p>
          )}
          {!principalArn && selectedPCRs.length > 0 && (
            <p className="text-xs text-yellow-600 dark:text-yellow-300 mt-2">⚠️ {t('kms.policy-editor.arnFromAttestationMissing', { defaultValue: 'Connect and verify attestation first — the instance role ARN is taken from the signed attestation.' })}</p>
          )}

          <button
            onClick={handleAddPCRFromTrustStore}
            disabled={isSaving || !principalArn || selectedPCRs.length === 0}
            className="btn btn-primary w-full mt-4"
          >
            {isSaving ? (
              <><span className="spinner-small"></span>{t('kms.policy-editor.updatingPolicy')}</>
            ) : (
              <>🔒 {t('kms.policy-editor.updateSelectedButton', { defaultValue: 'Update selected PCR values from trust store to KMS key policy' })}</>
            )}
          </button>

          {/* Raw key policy JSON (collapsible). */}
          {policy && (
            <div className="mt-4">
              <button onClick={() => setShowAdvanced(!showAdvanced)} className="text-xs text-blue-600 dark:text-blue-300 hover:text-blue-800">
                {showAdvanced ? t('kms.policy-editor.hideJson') : t('kms.policy-editor.showJson')}
              </button>
              {showAdvanced && (
                <div className="bg-gray-900 text-gray-100 rounded-lg p-4 overflow-x-auto mt-2">
                  <pre className="text-xs font-mono whitespace-pre-wrap">{JSON.stringify(policy, null, 2)}</pre>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {t('kms.policy-editor.noTrustStoreYet', { defaultValue: 'No trust-store baseline yet. Verify the backend and add its PCRs to the trust store in the Backend Connection tab first.' })}
        </div>
      )}


      {/* Error/Success Messages */}
      {error && (
        <div className="mt-4 p-3 bg-red-50 dark:bg-red-900 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {success && (
        <div className="mt-4 p-3 bg-green-50 dark:bg-green-900 border border-green-200 dark:border-green-800 rounded-lg text-sm text-green-700 dark:text-green-300">
          {success}
        </div>
      )}
    </div>
  )
}
