import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useConnection } from '../../contexts/ConnectionContext'
import { PCR_DESCRIPTIONS, isZeroPcr } from '../../types'

/**
 * Live "current state" card for the role dashboards. Reads the shared ConnectionContext
 * so the Workflow / Getting Started area reflects what the user has actually done:
 * whether a backend is connected, whether attestation verified, whether the PCRs match
 * the trust store, and the key measured PCRs (including the PCR16 model hash). Each
 * state links to the tab where the user acts next, so the flow is self-explanatory.
 *
 * `base` is the role route prefix (e.g. "/biologist") so the tab links resolve.
 */
export function ConnectionStatusCard({ base }: { base: string }) {
  const { t } = useTranslation()
  const { state } = useConnection()
  const { isConnected, isVerified, attestation, trustStore, pcrComparison, url } = state

  const anyMismatch =
    !!pcrComparison && Object.values(pcrComparison).some(p => p.expected !== null && !p.match)

  // Show the PCRs that matter for a quick glance: measured ones + PCR16 (model hash).
  const highlightPcrs = ['pcr0', 'pcr4', 'pcr7', 'pcr12', 'pcr16']
  const pcrRows = attestation
    ? highlightPcrs
        .filter(k => attestation.pcr_values[k] !== undefined)
        .map(k => ({ key: k, value: attestation.pcr_values[k] }))
    : []

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('common.connection-status.backendStatus')}</h2>
        <Link to={`${base}/connect`} className="btn btn-secondary btn-sm">
          {isConnected
            ? t('common.connection-status.manageConnection')
            : t('common.connection-status.connectBackend')}
        </Link>
      </div>

      {!isConnected ? (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700">
          <span className="status-indicator status-pending"></span>
          <div>
            <p className="font-medium text-gray-900 dark:text-gray-100">{t('common.connection-status.noBackendConnected')}</p>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              <Trans i18nKey="common.connection-status.connectPrompt">{/* nosemgrep: jsx-not-internationalized */}
                Go to <Link to={`${base}/connect`} className="text-primary-600 underline">Backend Connection</Link> and{/* nosemgrep: jsx-not-internationalized */}
                run Connect &amp; Verify to attest an EC2 instance.
              </Trans>
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Status line */}
          <div
            className={`flex items-center gap-3 p-4 rounded-lg border ${
              isVerified
                ? 'bg-green-50 dark:bg-green-900 border-green-200 dark:border-green-800'
                : 'bg-yellow-50 dark:bg-yellow-900 border-yellow-200 dark:border-yellow-800'
            }`}
          >
            <span className={`status-indicator ${isVerified ? 'status-connected' : 'status-pending'}`}></span>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {isVerified
                  ? t('common.connection-status.connectedVerified')
                  : anyMismatch
                  ? t('common.connection-status.connectedMismatch')
                  : t('common.connection-status.connectedPending')}
              </p>
              <p className="text-sm text-gray-600 dark:text-gray-400 truncate">{url}</p>
            </div>
            {anyMismatch && (
              <Link to={`${base}/connect`} className="btn btn-primary btn-sm whitespace-nowrap">
                {t('common.connection-status.reviewRetrust')}
              </Link>
            )}
          </div>

          {/* Verification checks */}
          {attestation && (
            <div className="flex flex-wrap gap-2 text-xs">
              <StatusChip ok={!!attestation.enclave_info.cose_verified} label={t('common.connection-status.coseSignature')} />
              <StatusChip ok={!!attestation.enclave_info.certificate_chain_verified} label={t('common.connection-status.certChain')} />
              <StatusChip ok={!!attestation.enclave_info.root_verified} label={t('common.connection-status.awsRootCa')} />
              <StatusChip
                ok={!!trustStore}
                label={trustStore ? t('common.connection-status.trustStoreSet') : t('common.connection-status.noTrustStore')}
              />
            </div>
          )}

          {/* Key PCRs */}
          {pcrRows.length > 0 && (
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('common.connection-status.trustedMeasurements')}</p>
              <div className="space-y-1">
                {pcrRows.map(({ key, value }) => (
                  <div key={key} className="flex items-baseline gap-2 text-xs">
                    <span className="font-medium w-14 flex-shrink-0">{key.toUpperCase()}</span>
                    <span className="text-gray-500 dark:text-gray-400 w-56 flex-shrink-0 truncate">
                      {PCR_DESCRIPTIONS[key]}
                      {key === 'pcr16' ? t('common.connection-status.modelHashSuffix') : ''}
                    </span>
                    <code className="font-mono text-gray-700 dark:text-gray-300 truncate" title={value}>
                      {isZeroPcr(value) ? t('common.connection-status.allZeros') : `${value.substring(0, 32)}…`}
                    </code>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-2">
                <Trans i18nKey="common.connection-status.fullPcrTablePrompt">{/* nosemgrep: jsx-not-internationalized */}
                  Full PCR table and re-trust controls are on the{' '}
                  <Link to={`${base}/connect`} className="text-primary-600 underline">{/* nosemgrep: jsx-not-internationalized */}
                    Backend Connection
                  </Link>{' '}
                  tab.
                </Trans>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-full ${
        ok ? 'bg-green-100 dark:bg-green-800 text-green-800 dark:text-green-200' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
      }`}
    >
      <span>{ok ? '✓' : '—'}</span>
      {label}
    </span>
  )
}

/** Compute workflow step statuses from the live connection state. */
export function useWorkflowStatus() {
  const { state } = useConnection()
  const connectComplete = state.isConnected && state.isVerified
  const connectActive = !connectComplete
  return { connectComplete, connectActive }
}
