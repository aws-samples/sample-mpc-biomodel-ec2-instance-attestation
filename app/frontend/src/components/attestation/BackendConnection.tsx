import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { AttestationDocument, TrustStoreEntry } from '../../types'
import { PCR_DESCRIPTIONS, PCR_MEANINGS, normalizePcrValues, isZeroPcr } from '../../types'
import { useRole } from '../../contexts/RoleContext'
import { useConnection } from '../../contexts/ConnectionContext'
import { getTrustStore, saveTrustStore } from '../../services/trustStore'
import { inspectAttestationDocument } from '../../services/attestationVerifier'
import { saveAttestationSession, clearAttestationSession } from '../../services/attestationSession'
import { getVerifiedPcrs } from '../../types'
import { getIdToken } from '../../services/api'
import { fetchUserAttributes } from 'aws-amplify/auth'
import { notify } from '../../services/notify'

export function BackendConnection() {
  // Connection + attestation state lives in ConnectionContext so it survives
  // navigating away to another tab (e.g. Prediction Jobs) and back.
  const { state, setState } = useConnection()

  const [showAddToTrustStore, setShowAddToTrustStore] = useState(false)
  const [isSavingTrustStore, setIsSavingTrustStore] = useState(false)
  const { role } = useRole()
  const { t } = useTranslation()

  // Generate cryptographically secure nonce
  const generateNonce = (): string => {
    const array = new Uint8Array(32)
    crypto.getRandomValues(array)
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('')
  }

  // Load the client's pinned PCR baseline from BROWSER-LOCAL storage (services/trustStore.ts).
  // The baseline is the relying party's own record of "PCRs I have inspected and trust"; it
  // must not be read from a backend-owned store, which would expand the trust boundary to the
  // very service being attested.
  const loadTrustStore = async (): Promise<TrustStoreEntry | null> => {
    if (!role) {
      console.log('No role selected, cannot load trust store')
      return null
    }

    try {
      const trustStore = getTrustStore(role, 'prod')
      if (trustStore) {
        // Normalize baseline keys too so they compare against the (normalized) attestation.
        trustStore.pcr_values = normalizePcrValues(trustStore.pcr_values)
      }
      return trustStore
    } catch (error) {
      console.error('Failed to load trust store from browser storage:', error)
      return null
    }
  }

  // Compare PCR values against trust store
  const comparePCRs = (
    pcrValues: Record<string, string>,
    trustStore: TrustStoreEntry | null
  ): Record<string, { value: string; expected: string | null; match: boolean }> => {
    const comparison: Record<string, { value: string; expected: string | null; match: boolean }> = {}
    
    for (const [pcr, value] of Object.entries(pcrValues)) {
      const expected = trustStore?.pcr_values?.[pcr] || null
      comparison[pcr] = {
        value,
        expected,
        match: expected === null || expected === value,
      }
    }
    
    return comparison
  }

  // Connect and verify attestation
  const connectAndVerify = async () => {
    if (!state.url.trim()) {
      setState(prev => ({ ...prev, error: t('attestation.backend.errorEnterUrl') }))
      return
    }

    setState(prev => ({
      ...prev,
      isConnecting: true,
      error: null,
      attestation: null,
      pcrComparison: null,
    }))

    try {
      // Save URL to localStorage
      localStorage.setItem('backendUrl', state.url)

      // Generate nonce for freshness
      const nonce = generateNonce()
      
      // Request attestation from backend. /api/v1/* is protected by the Cognito
      // JWT authorizer on API Gateway, so attach the signed-in user's ID token —
      // without it the gateway returns 401.
      const token = await getIdToken()
      const response = await fetch(`${state.url}/api/v1/attestation?nonce=${nonce}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })

      if (!response.ok) {
        throw new Error(t('attestation.backend.errorFetchAttestation', { statusText: response.statusText }))
      }

      const attestation: AttestationDocument = await response.json()

      // The BROWSER verifies the signed attestation itself: parse the COSE_Sign1, verify the
      // X.509 chain link-by-link and anchor it to the PINNED AWS Nitro root, verify the
      // COSE signature under the anchored leaf key, and check the nonce. We do NOT trust the
      // backend's self-reported enclave_info flags — an instance that lies about its PCRs
      // would also report verified=true, so self-attestation is no evidence. `raw_attestation`
      // is the base64 CBOR of the signed document.
      const inspection = await inspectAttestationDocument(attestation.raw_attestation || '', nonce)

      // Use the PCRs read from the VERIFIED document (bare index keys -> normalized), not the
      // backend-parsed copy. Everything downstream (trust store, KMS policy) keys off this.
      const verifiedPcrs = normalizePcrValues(getVerifiedPcrs(inspection) || {})
      attestation.pcr_values = verifiedPcrs

      // Load trust store for comparison
      const trustStore = await loadTrustStore()

      // Compare PCR values (browser-verified) against the pinned baseline.
      const pcrComparison = comparePCRs(verifiedPcrs, trustStore)

      // "Verified" requires BOTH the browser's own cryptographic verdict AND a NON-VACUOUS
      // match against a trusted baseline. An empty trust store never reads as verified.
      const cryptoOk = inspection.verified === true
      const comparedPcrs = Object.values(pcrComparison).filter(p => p.expected !== null)
      const trustMatched =
        !!trustStore && comparedPcrs.length > 0 && comparedPcrs.every(p => p.match)
      const isVerified = cryptoOk && trustMatched

      setState(prev => ({
        ...prev,
        isConnecting: false,
        isConnected: true,
        isVerified,
        attestation,
        inspection,
        trustStore,
        pcrComparison,
        error: cryptoOk
          ? null
          : (inspection.error || t('attestation.backend.errorVerifyFailed', { defaultValue: 'Attestation verification failed in the browser' })),
      }))

      // Cache the verified session so a page refresh restores it (re-verified locally)
      // instead of forcing a reconnect. Bounded by the leaf cert's expiry (~3h).
      if (cryptoOk && role) {
        saveAttestationSession(role, {
          url: state.url,
          attestation,
          certExpiry: inspection.certificates?.[0]?.not_after ?? null,
          savedAt: new Date().toISOString(),
        })
      } else if (role) {
        clearAttestationSession(role)
      }

      // Do NOT auto-open the trust dialog. The user must first review the
      // verification checks and PCR table below, then explicitly choose to trust.
      // An inline prompt (rendered below) offers the "Add to Trust Store" action.

    } catch (error) {
      setState(prev => ({
        ...prev,
        isConnecting: false,
        isConnected: false,
        isVerified: false,
        error: error instanceof Error ? error.message : t('attestation.backend.errorConnectionFailed'),
      }))
    }
  }

  // Add current PCR values to trust store
  const addToTrustStore = async () => {
    if (!state.attestation || !role) {
      notify(t('attestation.backend.notifySelectRole'))
      return
    }

    setIsSavingTrustStore(true)
    
    try {
      // Get current user email
      let userEmail = 'unknown'
      try {
        const attributes = await fetchUserAttributes()
        userEmail = attributes.email || 'unknown'
      } catch (e) {
        console.warn('Could not fetch user email:', e)
      }

      // Save to SSM Parameter Store
      await saveTrustStore(role, state.attestation.pcr_values, userEmail, 'prod')
      
      // Update local state
      const newTrustStore: TrustStoreEntry = {
        environment: 'prod',
        pcr_values: state.attestation.pcr_values,
        last_updated: new Date().toISOString(),
        updated_by: userEmail,
      }

      const pcrComparison = comparePCRs(state.attestation.pcr_values, newTrustStore)

      setState(prev => ({
        ...prev,
        trustStore: newTrustStore,
        pcrComparison,
        isVerified: true,
      }))

      const wasUpdate = !!state.trustStore
      setShowAddToTrustStore(false)

      notify(
        wasUpdate
          ? t('attestation.backend.notifyBaselineUpdated')
          : t('attestation.backend.notifyBaselineAdded')
      )
    } catch (error) {
      console.error('Failed to save to trust store:', error)
      notify(t('attestation.backend.notifySaveFailed', { error: error instanceof Error ? error.message : t('attestation.backend.unknownError') }))
    } finally {
      setIsSavingTrustStore(false)
    }
  }

  // Disconnect
  const disconnect = () => {
    if (role) clearAttestationSession(role)
    setState(prev => ({
      ...prev,
      isConnected: false,
      isVerified: false,
      attestation: null,
      inspection: null,
      pcrComparison: null,
      error: null,
    }))
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('attestation.backend.title')}</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">
          {t('attestation.backend.subtitle')}
        </p>
      </div>

      {/* Connection Form */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('attestation.backend.connectHeading')}</h2>

        <div className="flex gap-4">
          <div className="flex-1">
            <label className="label">{t('attestation.backend.backendUrlLabel')}</label>
            <input
              type="url"
              className="input"
              placeholder={t('attestation.backend.urlPlaceholder')}
              value={state.url}
              onChange={(e) => setState(prev => ({ ...prev, url: e.target.value }))}
              disabled={state.isConnected}
            />
          </div>
          
          {/* Attest is always available: there is no persistent connection, so the same
              action re-runs the stateless fetch + browser verification. Re-attest anytime
              to refresh (e.g. after a model/PCR16 change or a new AMI). "Clear" forgets the
              cached, browser-verified session for this role. */}
          <button
            onClick={connectAndVerify}
            disabled={state.isConnecting}
            className="btn btn-primary self-end"
          >
            {state.isConnecting ? (
              <>
                <span className="spinner-small"></span>
                {t('attestation.backend.connecting')}
              </>
            ) : (
              <>
                <span>🔐</span>
                {state.isConnected ? t('attestation.backend.reattest') : t('attestation.backend.connectAndVerify')}
              </>
            )}
          </button>
          {state.isConnected && (
            <button
              onClick={disconnect}
              disabled={state.isConnecting}
              className="btn btn-secondary self-end"
            >
              {t('attestation.backend.disconnect')}
            </button>
          )}
        </div>

        {state.error && (
          <div className="mt-4 p-4 bg-red-50 dark:bg-red-900 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300">
            <strong>{t('attestation.backend.errorLabel')}</strong> {state.error}
          </div>
        )}
      </div>

      {/* Connection Status */}
      {state.isConnected && (
        <div className={`card ${state.isVerified ? 'bg-green-50 dark:bg-green-900 border-green-200 dark:border-green-800' : 'bg-yellow-50 dark:bg-yellow-900 border-yellow-200 dark:border-yellow-800'}`}>
          <div className="flex items-center gap-3">
            <div className={`status-indicator ${state.isVerified ? 'status-connected' : 'status-pending'}`}></div>
            <div>
              <h3 className="font-semibold text-gray-900 dark:text-gray-100">
                {state.isVerified ? t('attestation.backend.verifiedConnection') : t('attestation.backend.connectedPending')}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">{state.url}</p>
            </div>
          </div>
        </div>
      )}

      {/* Attestation Details */}
      {state.attestation && (
        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('attestation.backend.attestationDocument')}</h2>

          {/* Verification Checks */}
          <div className="mb-6">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">{t('attestation.backend.verificationStatus')}</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div className={`p-3 rounded-lg ${state.attestation.enclave_info.tpm_available ? 'bg-green-50 dark:bg-green-900' : 'bg-red-50 dark:bg-red-900'}`}>
                <span className="text-lg mr-2">{state.attestation.enclave_info.tpm_available ? '✓' : '✗'}</span>
                <span className="text-sm">{t('attestation.backend.tpmAvailable')}</span>
              </div>
              {/* Crypto checks below are the BROWSER's own verdict (services/attestationVerifier),
                  not backend-asserted flags. */}
              <div className={`p-3 rounded-lg ${state.inspection?.signature_verified ? 'bg-green-50 dark:bg-green-900' : 'bg-red-50 dark:bg-red-900'}`}>
                <span className="text-lg mr-2">{state.inspection?.signature_verified ? '✓' : '✗'}</span>
                <span className="text-sm">{t('attestation.backend.coseVerified')}</span>
              </div>
              <div className={`p-3 rounded-lg ${state.inspection?.chain_verified ? 'bg-green-50 dark:bg-green-900' : 'bg-red-50 dark:bg-red-900'}`}>
                <span className="text-lg mr-2">{state.inspection?.chain_verified ? '✓' : '✗'}</span>
                <span className="text-sm">{t('attestation.backend.certChainValid')}</span>
              </div>
              <div className={`p-3 rounded-lg ${state.inspection?.nonce_verified ? 'bg-green-50 dark:bg-green-900' : 'bg-red-50 dark:bg-red-900'}`}>
                <span className="text-lg mr-2">{state.inspection?.nonce_verified ? '✓' : '✗'}</span>
                <span className="text-sm">{t('attestation.backend.nonceFresh', { defaultValue: 'Nonce fresh' })}</span>
              </div>
              <div className={`p-3 rounded-lg ${!state.attestation.enclave_info.debug_mode ? 'bg-green-50 dark:bg-green-900' : 'bg-yellow-50 dark:bg-yellow-900'}`}>
                <span className="text-lg mr-2">{!state.attestation.enclave_info.debug_mode ? '✓' : '⚠'}</span>
                <span className="text-sm">{t('attestation.backend.productionMode')}</span>
              </div>
              <div className={`p-3 rounded-lg ${state.attestation.enclave_info.memory_encrypted ? 'bg-green-50 dark:bg-green-900' : 'bg-red-50 dark:bg-red-900'}`}>
                <span className="text-lg mr-2">{state.attestation.enclave_info.memory_encrypted ? '✓' : '✗'}</span>
                <span className="text-sm">{t('attestation.backend.memoryEncrypted')}</span>
              </div>
            </div>
          </div>

          {/* Enclave Info */}
          <div className="mb-6">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">{t('attestation.backend.enclaveInformation')}</h3>
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">{t('attestation.backend.moduleId')}</span>
                <span className="font-mono">{state.attestation.enclave_info.module_id}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">{t('attestation.backend.application')}</span>
                <span>{state.attestation.enclave_info.application}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">{t('attestation.backend.timestamp')}</span>
                <span>{new Date(state.attestation.timestamp).toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">{t('attestation.backend.nonce')}</span>
                <span className="font-mono text-xs" title={state.attestation.nonce}>{state.attestation.nonce}</span>
              </div>
              {(state.attestation.user_data || state.attestation.enclave_info.iam_role_arn) && (
                <div className="flex justify-between gap-4">
                  <span className="text-gray-600 dark:text-gray-400 whitespace-nowrap">
                    {t('attestation.backend.instanceRoleArn', { defaultValue: 'Instance role ARN (signed user_data)' })}
                  </span>
                  <span
                    className="font-mono text-xs break-all text-right"
                    title={state.attestation.user_data || state.attestation.enclave_info.iam_role_arn}
                  >
                    {state.attestation.user_data || state.attestation.enclave_info.iam_role_arn}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* PCR Values */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('attestation.backend.pcrValues')}</h3>
              {!state.trustStore && (
                <span className="badge badge-warning">{t('attestation.backend.noTrustStoreConfigured')}</span>
              )}
            </div>

            {/* No-baseline banner: attestation proof is in but the user has not yet
                recorded a trusted baseline for this role. The connection is therefore
                NOT "verified" — prompt the user to review the checks + PCR table above
                and then explicitly trust. This replaces the old auto-opening modal so
                the user reviews before trusting. */}
            {!state.trustStore && (
              <div className="mb-4 p-4 bg-blue-50 dark:bg-blue-900 border border-blue-200 dark:border-blue-800 rounded-lg">
                <div className="flex items-start justify-between gap-4">
                  <div className="text-sm text-blue-800 dark:text-blue-200">
                    <Trans i18nKey="attestation.backend.reviewBeforeTrusting">{/* nosemgrep: jsx-not-internationalized */}
                      <strong>Review before trusting.</strong> The attestation proof was received.{/* nosemgrep: jsx-not-internationalized */}
                      Inspect the verification checks and the PCR values below. If you are satisfied
                      this is a legitimate backend, record these measurements as your trusted baseline.
                      Until you do, this connection is <strong>not marked verified</strong>.{/* nosemgrep: jsx-not-internationalized */}
                    </Trans>
                    {/* Plain t() + a separate <a> rather than a numbered <Trans> tag: the
                        numbered-tag interpolation misaligned and duplicated the sentence. */}
                    <p className="mt-2 text-xs text-blue-700 dark:text-blue-300">
                      {t('attestation.backend.zoaOutOfScope')}{' '}
                      <a
                        href="https://github.com/aws-samples/sample-mpc-biomodel-ec2-instance-attestation/blob/main/packaging-kiwi-ng/kiwi/config.xml"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline font-mono"
                      >{t('attestation.backend.zoaRepoLink')}</a>{' '}
                      {t('attestation.backend.zoaOutOfScopeSuffix')}
                    </p>
                  </div>
                  <button
                    onClick={() => setShowAddToTrustStore(true)}
                    disabled={!role}
                    className="btn btn-primary whitespace-nowrap self-start"
                  >
                    {t('attestation.backend.addToTrustStore')}
                  </button>
                </div>
              </div>
            )}

            {/* Mismatch banner: trust store exists but one or more PCRs differ from
                the baseline (expected after an AMI rebuild / model reload). Offers a
                path to review and replace the baseline — otherwise the connection is
                stuck "unverified" with no way forward. */}
            {state.trustStore && state.pcrComparison &&
              Object.values(state.pcrComparison).some(p => p.expected !== null && !p.match) && (
              <div className="mb-4 p-4 bg-yellow-50 dark:bg-yellow-900 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                <div className="flex items-start justify-between gap-4">
                  <div className="text-sm text-yellow-800 dark:text-yellow-200">
                    <Trans i18nKey="attestation.backend.pcrMismatchBanner">{/* nosemgrep: jsx-not-internationalized */}
                      <strong>⚠ PCR mismatch:</strong> the backend&apos;s measurements differ from the
                      stored trust-store baseline. This is expected after a legitimate AMI rebuild or model
                      reload. If you trust this instance, update the baseline to the current values.
                    </Trans>
                  </div>
                  <button
                    onClick={() => setShowAddToTrustStore(true)}
                    disabled={!role}
                    className="btn btn-primary whitespace-nowrap self-start"
                  >
                    {t('attestation.backend.updateTrustStore')}
                  </button>
                </div>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    <th className="text-left py-2 px-3">{t('attestation.backend.thPcr')}</th>
                    <th className="text-left py-2 px-3">{t('attestation.backend.thDescription')}</th>
                    <th className="text-left py-2 px-3">{t('attestation.backend.thValue')}</th>
                    <th className="text-left py-2 px-3">{t('attestation.backend.thStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {state.pcrComparison && Object.entries(state.pcrComparison)
                    .sort((a, b) => {
                      const numA = parseInt(a[0].replace('pcr', ''))
                      const numB = parseInt(b[0].replace('pcr', ''))
                      return numA - numB
                    })
                    .map(([pcr, data]) => {
                      const key = pcr.toLowerCase()
                      const isZero = isZeroPcr(data.value)
                      const isHighlight = key === 'pcr16'
                      const meaning = PCR_MEANINGS[key]

                      return (
                        <tr
                          key={pcr}
                          className={`border-b border-gray-100 dark:border-gray-700 ${isHighlight ? 'bg-blue-50 dark:bg-blue-900' : ''} ${isZero ? 'opacity-60' : ''}`}
                        >
                          <td className="py-2 px-3 font-medium align-top whitespace-nowrap">
                            {pcr.toUpperCase()}
                            {isHighlight && (
                              <span className="ml-2 badge badge-info align-middle">{t('attestation.backend.modelHash')}</span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-gray-600 dark:text-gray-400 align-top max-w-md">
                            <div className="font-medium text-gray-700 dark:text-gray-300">
                              {PCR_DESCRIPTIONS[key] || t('attestation.backend.reserved')}
                            </div>
                            {meaning && (
                              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{meaning}</div>
                            )}
                            {isZero && (
                              <div className="text-xs text-gray-400 mt-0.5 italic">
                                {t('attestation.backend.notExtended')}
                              </div>
                            )}
                          </td>
                          <td className="py-2 px-3 align-top">
                            <code className="pcr-value" title={data.value}>{data.value}</code>
                          </td>
                          <td className="py-2 px-3 align-top">
                            {data.expected === null ? (
                              <span className="badge badge-gray">{t('attestation.backend.noBaseline')}</span>
                            ) : data.match ? (
                              <span className="badge badge-success">{t('attestation.backend.match')}</span>
                            ) : (
                              <span className="badge badge-error">{t('attestation.backend.mismatch')}</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Add / Update Trust Store Modal */}
      {showAddToTrustStore && state.attestation && (
        <div className="modal-overlay" onClick={() => setShowAddToTrustStore(false)}>
          <div className="modal-content max-w-lg" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="text-lg font-semibold">
                {state.trustStore ? t('attestation.backend.modalUpdateTitle') : t('attestation.backend.modalAddTitle')}
              </h2>
              <button onClick={() => setShowAddToTrustStore(false)} className="text-gray-400 hover:text-gray-600">
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                {state.trustStore
                  ? t('attestation.backend.modalUpdateBody')
                  : t('attestation.backend.modalAddBody')}
              </p>
              <div className="bg-yellow-50 dark:bg-yellow-900 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 text-sm text-yellow-800 dark:text-yellow-200">
                <Trans
                  i18nKey="attestation.backend.modalImportantNote"
                  values={{ action: state.trustStore ? t('attestation.backend.actionReplace') : t('attestation.backend.actionAdd') }}
                >{/* nosemgrep: jsx-not-internationalized */}
                  <strong>⚠ Important:</strong> Only {'{{action}}'} these values if you trust this is a legitimate, uncompromised backend instance. These values will be used to verify future connections.{/* nosemgrep: jsx-not-internationalized */}
                </Trans>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowAddToTrustStore(false)} className="btn btn-secondary">
                {state.trustStore ? t('attestation.backend.cancel') : t('attestation.backend.skipForNow')}
              </button>
              <button
                onClick={addToTrustStore}
                disabled={isSavingTrustStore || !role}
                className="btn btn-primary"
              >
                {isSavingTrustStore ? (
                  <>
                    <span className="spinner-small"></span>
                    {t('attestation.backend.saving')}
                  </>
                ) : (
                  state.trustStore ? t('attestation.backend.updateTrustStore') : t('attestation.backend.addToTrustStore')
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}