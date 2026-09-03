import { useState, useEffect } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { PredictionJob, JobStatus, AttestationDocument, SequenceLibraryItem } from '../../types'
import { normalizePcrValues, isZeroPcr } from '../../types'
import { apiRequest, apiBlobRequest, getBackendUrl, getIdToken } from '../../services/api'
import { useRole } from '../../contexts/RoleContext'
import { useConnection } from '../../contexts/ConnectionContext'
import { useAuth } from '../auth/AuthProvider'
import { listEncryptedSequences, getSequencesBucketName } from '../../services/s3'
import { notify } from '../../services/notify'
import { formatBackendDateTime, formatBackendDate } from '../../utils/datetime'
import { MoleculeViewer } from './MoleculeViewer'

interface ModelInfo {
  name: string
  hash: string
  description: string
}

export function JobHistory() {
  const { t } = useTranslation()
  const [jobs, setJobs] = useState<PredictionJob[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [selectedJob, setSelectedJob] = useState<PredictionJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  
  // New job state
  const [showNewJobModal, setShowNewJobModal] = useState(false)
  const [sequences, setSequences] = useState<SequenceLibraryItem[]>([])
  const [selectedSequence, setSelectedSequence] = useState<string | null>(null)
  const [attestation, setAttestation] = useState<AttestationDocument | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isLoadingSequences, setIsLoadingSequences] = useState(false)
  
  const { role } = useRole()
  const { user } = useAuth()
  // Reuse the verified attestation from the Backend Connection tab if present, so the
  // model hash is available here without re-connecting.
  const { state: connectionState } = useConnection()

  // Load job history from backend
  // silent=true is used by the background poll so it doesn't toggle the refresh spinner
  // (or clobber an existing error banner) every 5s.
  const loadJobs = async (silent = false) => {
    const backendUrl = getBackendUrl()
    if (!backendUrl) {
      setError(t('predictions.job-history.errorNoBackend'))
      return
    }

    if (!silent) {
      setIsLoading(true)
      setError(null)
    }
    try {
      const data = await apiRequest<PredictionJob[]>('/api/v1/jobs?limit=50')
      // Backend returns the identifier as `job_id`; the UI keys on `id`. Normalize so
      // clicking a job builds /results/<id> instead of /results/undefined.
      setJobs(data.map(j => ({ ...j, id: j.id || j.job_id || '' })))
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : t('predictions.job-history.errorLoadJobs'))
    } finally {
      if (!silent) setIsLoading(false)
    }
  }

  // Load job details
  const loadJobDetails = async (jobId: string) => {
    const backendUrl = getBackendUrl()
    if (!backendUrl) return

    try {
      const job = await apiRequest<PredictionJob>(`/api/v1/results/${jobId}`)
      setSelectedJob({ ...job, id: job.id || job.job_id || jobId })
    } catch (err) {
      console.error('Failed to load job details:', err)
    }
  }

  // Initial load.
  useEffect(() => {
    loadJobs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Poll the job list every 5s WHILE any job is pending/processing. This effect re-runs
  // whenever `jobs` changes (so it starts when a job is submitted and stops once all jobs
  // are terminal). Depending on `jobs` avoids the stale-closure bug of a single []-deps
  // interval that captured the initial empty list and therefore never polled. One list
  // fetch reflects every in-flight job at once, so this scales to many concurrent jobs.
  useEffect(() => {
    const anyRunning = jobs.some(j => j.status === 'pending' || j.status === 'processing')
    if (!anyRunning) return
    const interval = setInterval(() => loadJobs(true), 5000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs])

  // While an open job detail is still running, refresh just that job every 5s so the
  // detail view's progress bar advances without a manual refresh.
  useEffect(() => {
    const id = selectedJob?.id
    const running = selectedJob?.status === 'pending' || selectedJob?.status === 'processing'
    if (!id || !running) return
    const interval = setInterval(() => loadJobDetails(id), 5000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJob?.id, selectedJob?.status])

  // Get status badge color
  const getStatusBadge = (status: JobStatus) => {
    switch (status) {
      case 'completed':
        return 'badge-success'
      case 'failed':
        return 'badge-error'
      case 'processing':
        return 'badge-info'
      case 'pending':
      default:
        return 'badge-warning'
    }
  }

  // Format date. Backend timestamps are UTC-naive (datetime.utcnow().isoformat()),
  // so parse them as UTC before localizing — otherwise they display off by the local
  // UTC offset. See utils/datetime.ts.
  const formatDate = (dateStr: string) => formatBackendDateTime(dateStr)

  // Download file
  const downloadFile = async (jobId: string, fileType: string) => {
    const backendUrl = getBackendUrl()
    if (!backendUrl) return

    try {
      const blob = await apiBlobRequest(`/api/v1/jobs/${jobId}/download/${fileType}`)
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${jobId}_${fileType === 'pdb' ? 'structure.pdb' : fileType === 'confidence' ? 'confidence.json' : 'job.json'}`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      a.remove()
    } catch (err) {
      console.error('Download failed:', err)
    }
  }

  // Open new job modal and load sequences
  const openNewJobModal = async () => {
    setShowNewJobModal(true)
    setIsLoadingSequences(true)

    // Prefer the attestation already verified on the Backend Connection tab (kept in
    // ConnectionContext); its pcr_values are already normalized to pcr0/pcr16.
    if (connectionState.attestation) {
      setAttestation(connectionState.attestation)
    }

    try {
      // Otherwise fetch a fresh attestation and normalize the numeric PCR keys the
      // backend returns ("0"/"16") to the pcr0/pcr16 form the UI reads.
      const backendUrl = getBackendUrl()
      if (!connectionState.attestation && backendUrl) {
        const nonce = crypto.randomUUID().replace(/-/g, '')
        const token = await getIdToken()
        const response = await fetch(`${backendUrl}/api/v1/attestation?nonce=${nonce}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        if (response.ok) {
          const att: AttestationDocument = await response.json()
          att.pcr_values = normalizePcrValues(att.pcr_values)
          setAttestation(att)
        }
      }

      // Load encrypted sequences from S3. IMPORTANT: SequenceEncryption uploads under
      // <role>/<user.sub>/sequences/, so we must list by user.sub (Cognito user-pool
      // sub) — NOT the identity-pool id, which never matches the upload prefix.
      if (role && user?.sub) {
        const s3Sequences = await listEncryptedSequences(role, user.sub)
        const items: SequenceLibraryItem[] = s3Sequences.map(seq => ({
          id: seq.key,
          name: seq.name,
          sequence: '[Encrypted]',
          length: 0,
          type: 'protein' as const,
          encrypted: true,
          s3_key: seq.key,
          created_at: seq.lastModified.toISOString(),
        }))
        setSequences(items)
      }
    } catch (err) {
      console.error('Failed to load data for new job:', err)
    } finally {
      setIsLoadingSequences(false)
    }
  }

  // Submit new prediction job
  const submitNewJob = async () => {
    if (!selectedSequence) {
      notify(t('predictions.job-history.alertSelectSequence'))
      return
    }

    const backendUrl = getBackendUrl()
    if (!backendUrl) {
      notify(t('predictions.job-history.alertConnectBackend'))
      return
    }

    setIsSubmitting(true)
    try {
      const sequence = sequences.find(s => s.id === selectedSequence)
      if (!sequence?.s3_key) {
        throw new Error(t('predictions.job-history.errorNoS3Key'))
      }

      // Send only the bucket + key: the attested backend fetches the ciphertext and its
      // encryption context from S3 itself and decrypts under attestation. No need to pull
      // the ciphertext down to the browser and re-upload it in the request body.
      await apiRequest('/api/v1/predict', {
        method: 'POST',
        body: JSON.stringify({
          s3_bucket: getSequencesBucketName(role ?? 'biologist'),
          s3_key: sequence.s3_key,
          name: sequence.name,
        }),
      })

      setShowNewJobModal(false)
      setSelectedSequence(null)
      loadJobs()
    } catch (err) {
      notify(err instanceof Error ? err.message : t('predictions.job-history.errorSubmitJob'))
    } finally {
      setIsSubmitting(false)
    }
  }

  // Get model info from attestation (PCR16)
  const getModelInfo = (): ModelInfo | null => {
    if (!attestation) return null
    
    const pcr16 = attestation.pcr_values?.pcr16
    if (isZeroPcr(pcr16)) {
      return null
    }
    
    return {
      name: 'Boltz-1',
      hash: pcr16,
      description: t('predictions.job-history.modelDescription'),
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('predictions.job-history.title')}</h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">
            {t('predictions.job-history.subtitle')}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => loadJobs()} className="btn btn-secondary" disabled={isLoading}>
            {isLoading ? <span className="spinner-small"></span> : '🔄'} {t('predictions.job-history.refresh')}
          </button>
          <button onClick={openNewJobModal} className="btn btn-primary">
            ➕ {t('predictions.job-history.newJob')}
          </button>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="card bg-red-50 dark:bg-red-900 border-red-200 dark:border-red-800">
          <div className="flex items-center gap-3 text-red-700 dark:text-red-300">
            <span className="text-xl">⚠️</span>
            <p>{error}</p>
          </div>
        </div>
      )}

      {/* Job List */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Jobs List */}
        <div className="lg:col-span-1">
          <div className="card">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('predictions.job-history.jobHistoryHeading')}</h2>

            {isLoading && jobs.length === 0 ? (
              <div className="text-center py-8">
                <div className="spinner mx-auto mb-4"></div>
                <p className="text-gray-500 dark:text-gray-400">{t('predictions.job-history.loadingJobs')}</p>
              </div>
            ) : jobs.length === 0 ? (
              <div className="text-center py-8">
                <span className="text-4xl mb-4 block">📋</span>
                <p className="text-gray-500 dark:text-gray-400">{t('predictions.job-history.noJobsYet')}</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[600px] overflow-y-auto">
                {jobs.map(job => (
                  <div
                    key={job.id}
                    onClick={() => loadJobDetails(job.id)}
                    className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                      selectedJob?.id === job.id
                        ? 'border-primary-500 bg-primary-50'
                        : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-gray-900 dark:text-gray-100 truncate">
                        {job.sequence_name || job.id.substring(0, 8)}
                      </span>
                      <span className={`badge ${getStatusBadge(job.status)}`}>
                        {job.status}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      <Trans i18nKey="predictions.job-history.residuesAndDate" values={{ residues: job.sequence_length, date: formatDate(job.created_at) }}>{/* nosemgrep: jsx-not-internationalized */}{'{{residues}}'} residues • {'{{date}}'}</Trans>
                    </div>
                    {job.status === 'processing' && (
                      <div className="mt-2">
                        <div className="h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                          <div 
                            className="h-full bg-primary-500 transition-all"
                            style={{ width: `${job.progress || 0}%` }}
                          />
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{job.progress_message}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Job Details */}
        <div className="lg:col-span-2">
          {selectedJob ? (
            <div className="card">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {selectedJob.sequence_name || t('predictions.job-history.predictionDetails')}
                </h2>
                <span className={`badge ${getStatusBadge(selectedJob.status)}`}>
                  {selectedJob.status}
                </span>
              </div>

              {/* Job Info */}
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3">
                  <span className="text-xs text-gray-500 dark:text-gray-400">{t('predictions.job-history.jobId')}</span>
                  <p className="font-mono text-sm truncate">{selectedJob.id}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3">
                  <span className="text-xs text-gray-500 dark:text-gray-400">{t('predictions.job-history.sequenceLength')}</span>
                  <p className="font-medium"><Trans i18nKey="predictions.job-history.residuesCount" values={{ residues: selectedJob.sequence_length }}>{/* nosemgrep: jsx-not-internationalized */}{'{{residues}}'} residues</Trans></p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3">
                  <span className="text-xs text-gray-500 dark:text-gray-400">{t('predictions.job-history.created')}</span>
                  <p className="text-sm">{formatDate(selectedJob.created_at)}</p>
                </div>
                {selectedJob.completed_at && (
                  <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3">
                    <span className="text-xs text-gray-500 dark:text-gray-400">{t('predictions.job-history.completed')}</span>
                    <p className="text-sm">{formatDate(selectedJob.completed_at)}</p>
                  </div>
                )}
              </div>

              {/* Progress for running jobs */}
              {selectedJob.status === 'processing' && (
                <div className="mb-6">
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-gray-600 dark:text-gray-400">{selectedJob.progress_stage}</span>
                    <span className="font-medium">{selectedJob.progress}%</span>
                  </div>
                  <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-primary-500 transition-all"
                      style={{ width: `${selectedJob.progress || 0}%` }}
                    />
                  </div>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">{selectedJob.progress_message}</p>
                </div>
              )}

              {/* Error for failed jobs */}
              {selectedJob.status === 'failed' && selectedJob.error_message && (
                <div className="mb-6 p-4 bg-red-50 dark:bg-red-900 border border-red-200 dark:border-red-800 rounded-lg">
                  <p className="text-red-700 dark:text-red-300"><Trans i18nKey="predictions.job-history.errorLabel" values={{ message: selectedJob.error_message }}>{/* nosemgrep: jsx-not-internationalized */}<strong>Error:</strong> {'{{message}}'}</Trans></p>
                </div>
              )}

              {/* Results for completed jobs */}
              {selectedJob.status === 'completed' && selectedJob.structure && (
                <>
                  {/* Confidence Score — a STRUCTURE-QUALITY metric, not binding affinity */}
                  <div className="mb-6">
                    <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('predictions.job-history.structureConfidence')}</h3>
                    {selectedJob.confidence_score != null ? (
                      <div className="flex items-center gap-4">
                        <div className="text-3xl font-bold text-primary-600">
                          {(selectedJob.confidence_score * 100).toFixed(1)}%
                        </div>
                        <div className="text-sm text-gray-500 dark:text-gray-400">
                          {selectedJob.confidence_score > 0.9 ? t('predictions.job-history.veryHighConfidence') :
                           selectedJob.confidence_score > 0.7 ? t('predictions.job-history.highConfidence') :
                           selectedJob.confidence_score > 0.5 ? t('predictions.job-history.mediumConfidence') : t('predictions.job-history.lowConfidence')}
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-gray-500 dark:text-gray-400">{t('predictions.job-history.notReported')}</p>
                    )}
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      <Trans i18nKey="predictions.job-history.plddtExplanation">{/* nosemgrep: jsx-not-internationalized */}
                        pLDDT estimates how confident the model is in the predicted <strong>fold</strong> (0–100%).{/* nosemgrep: jsx-not-internationalized */}
                        It is a structure-quality score — not a binding affinity or an experimental measurement.
                      </Trans>
                    </p>
                  </div>

                  {/* Download Buttons */}
                  <div className="mb-6">
                    <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('predictions.job-history.downloadResults')}</h3>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => downloadFile(selectedJob.id, 'pdb')}
                        className="btn btn-secondary btn-small"
                      >
                        📥 {t('predictions.job-history.pdbStructure')}
                      </button>
                      <button
                        onClick={() => downloadFile(selectedJob.id, 'confidence')}
                        className="btn btn-secondary btn-small"
                      >
                        📊 {t('predictions.job-history.confidenceJson')}
                      </button>
                      <button
                        onClick={() => downloadFile(selectedJob.id, 'metadata')}
                        className="btn btn-secondary btn-small"
                      >
                        📋 {t('predictions.job-history.jobMetadata')}
                      </button>
                    </div>
                  </div>

                  {/* 3D Structure viewer (3Dmol.js) — renders the predicted PDB inline */}
                  <div>
                    <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('predictions.job-history.predicted3dStructure')}</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                      <Trans i18nKey="predictions.job-history.structureDescription">{/* nosemgrep: jsx-not-internationalized */}
                        This is the predicted folded shape of your <strong>single input protein</strong> — the model{/* nosemgrep: jsx-not-internationalized */}
                        infers where each amino acid sits in 3D. It is <strong>not</strong> a docking or binding result:{/* nosemgrep: jsx-not-internationalized */}
                        there is no second molecule, no DNA/RNA, and no binding-affinity calculation. The ribbon is
                        colored from the start of the chain (blue) to the end (red) to help you trace the backbone;
                        the colors carry no other meaning. Drag to rotate, scroll to zoom.
                      </Trans>
                    </p>
                    {(selectedJob.structure?.pdb_string || selectedJob.structure?.pdb_data) ? (
                      <MoleculeViewer
                        pdb={(selectedJob.structure.pdb_string || selectedJob.structure.pdb_data) as string}
                      />
                    ) : (
                      <div className="viewer-container flex items-center justify-center bg-gray-100 dark:bg-gray-700">
                        <div className="text-center">
                          <span className="text-4xl mb-2 block">🔬</span>
                          <p className="text-gray-500 dark:text-gray-400">{t('predictions.job-history.noStructureData')}</p>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="card h-full flex items-center justify-center">
              <div className="text-center py-12">
                <span className="text-4xl mb-4 block">👆</span>
                <p className="text-gray-500 dark:text-gray-400">{t('predictions.job-history.selectJobPrompt')}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* New Job Modal */}
      {showNewJobModal && (
        <div className="modal-overlay" onClick={() => setShowNewJobModal(false)}>
          <div className="modal-content max-w-2xl" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="text-lg font-semibold">{t('predictions.job-history.startNewJob')}</h2>
              <button onClick={() => setShowNewJobModal(false)} className="text-gray-400 hover:text-gray-600">
                ✕
              </button>
            </div>
            <div className="modal-body space-y-6">
              {/* Model Information */}
              <div>
                <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">🧠 {t('predictions.job-history.modelHeading')}</h3>
                {getModelInfo() ? (
                  <div className="bg-blue-50 dark:bg-blue-900 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-2xl">🔬</span>
                      <div>
                        <h4 className="font-semibold text-gray-900 dark:text-gray-100">{getModelInfo()!.name}</h4>
                        <p className="text-sm text-gray-600 dark:text-gray-400">{getModelInfo()!.description}</p>
                      </div>
                    </div>
                    <div className="mt-3 p-2 bg-white dark:bg-gray-800 rounded border">
                      <span className="text-xs text-gray-500 dark:text-gray-400">{t('predictions.job-history.pcr16Label')}</span>
                      <p className="font-mono text-xs text-gray-700 dark:text-gray-300 break-all mt-1">
                        {getModelInfo()!.hash}
                      </p>
                    </div>
                    <p className="text-xs text-green-600 dark:text-green-300 mt-2">
                      ✓ {t('predictions.job-history.modelVerified')}
                    </p>
                  </div>
                ) : (
                  <div className="bg-yellow-50 dark:bg-yellow-900 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 text-yellow-800 dark:text-yellow-200">
                    <p className="text-sm">
                      <Trans i18nKey="predictions.job-history.noModelHash">{/* nosemgrep: jsx-not-internationalized */}
                        ⚠️ No model hash available yet. Open the <strong>Backend Connection</strong> tab and{/* nosemgrep: jsx-not-internationalized */}
                        run <strong>Connect &amp; Verify</strong> — once attestation succeeds, PCR16 (the Boltz{/* nosemgrep: jsx-not-internationalized */}
                        model hash) is picked up here automatically.
                      </Trans>
                    </p>
                  </div>
                )}
              </div>

              {/* Sequence Selection */}
              <div>
                <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">🧬 {t('predictions.job-history.selectSequenceHeading')}</h3>
                {isLoadingSequences ? (
                  <div className="text-center py-8">
                    <div className="spinner mx-auto mb-2"></div>
                    <p className="text-sm text-gray-500 dark:text-gray-400">{t('predictions.job-history.loadingSequences')}</p>
                  </div>
                ) : sequences.length === 0 ? (
                  <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4 text-center">
                    <p className="text-gray-600 dark:text-gray-400 mb-2">{t('predictions.job-history.noSequencesFound')}</p>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {t('predictions.job-history.goToSequencesTab')}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {sequences.map(seq => (
                      <label
                        key={seq.id}
                        className={`
                          flex items-center gap-3 p-3 border rounded-lg cursor-pointer transition-colors
                          ${selectedSequence === seq.id 
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900'
                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'}
                        `}
                      >
                        <input
                          type="radio"
                          name="sequence"
                          value={seq.id}
                          checked={selectedSequence === seq.id}
                          onChange={() => setSelectedSequence(seq.id)}
                          className="rounded-full"
                        />
                        <div className="flex-1">
                          <div className="font-medium text-gray-900 dark:text-gray-100">{seq.name}</div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            <Trans i18nKey="predictions.job-history.encryptedDate" values={{ date: formatBackendDate(seq.created_at) }}>{/* nosemgrep: jsx-not-internationalized */}{'{{date}}'} • 🔐 Encrypted</Trans>
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Prediction Info */}
              <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4 text-sm text-gray-600 dark:text-gray-400">
                <h4 className="font-medium text-gray-700 dark:text-gray-300 mb-2">{t('predictions.job-history.whatThisPredicts')}</h4>
                <p className="mb-2">
                  <Trans i18nKey="predictions.job-history.whatThisPredictsBody">{/* nosemgrep: jsx-not-internationalized */}
                    Given <strong>one protein sequence</strong>, the Boltz-1 model predicts its{/* nosemgrep: jsx-not-internationalized */}
                    <strong> 3D folded structure</strong> (where each amino acid sits in space) and returns a
                    downloadable PDB plus a structure-confidence score (pLDDT). It does <strong>not</strong> do{/* nosemgrep: jsx-not-internationalized */}
                    docking, protein–protein / protein–DNA complexes, or binding-affinity prediction.
                  </Trans>
                </p>
                <h4 className="font-medium text-gray-700 dark:text-gray-300 mb-2">{t('predictions.job-history.howItWorks')}</h4>
                <ol className="list-decimal list-inside space-y-1">
                  <li>{t('predictions.job-history.howStep1')}</li>
                  <li>{t('predictions.job-history.howStep2')}</li>
                  <li>{t('predictions.job-history.howStep3')}</li>
                  <li>{t('predictions.job-history.howStep4')}</li>
                </ol>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowNewJobModal(false)} className="btn btn-secondary">
                {t('predictions.job-history.cancel')}
              </button>
              <button
                onClick={submitNewJob}
                disabled={isSubmitting || !selectedSequence || !getModelInfo()}
                className="btn btn-primary"
              >
                {isSubmitting ? (
                  <>
                    <span className="spinner-small"></span>
                    {t('predictions.job-history.submitting')}
                  </>
                ) : (
                  <>
                    🚀 {t('predictions.job-history.startPrediction')}
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
