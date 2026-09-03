import { useState, useEffect, useRef } from 'react'
import { SFNClient, StartExecutionCommand, DescribeExecutionCommand } from '@aws-sdk/client-sfn'
import { fetchAuthSession } from 'aws-amplify/auth'
import { useTranslation } from 'react-i18next'
import { getParameter, getModelProgress } from '../../services/ssm'

interface ModelVersion {
  version: string
  s3_path: string
  hash: string
  created_at: string
}

const REGION = import.meta.env.VITE_AWS_REGION || 'us-east-1'
const STATE_MACHINE_ARN = `arn:aws:states:${REGION}:${import.meta.env.VITE_AWS_ACCOUNT_ID || '857542160605'}:stateMachine:boltz-model-update-workflow`

/**
 * mode splits the two phases of the model lifecycle across the two nav tabs:
 *   'weights' (Model Weights tab) = PRODUCE: current model + download/encrypt from HF -> S3
 *   'deploy'  (Deployments tab)   = CONSUME: deploy/reload the encrypted weights S3 -> instance
 * Previously both tabs rendered every section, so they looked identical.
 */
export function ModelManager({ mode = 'weights' }: { mode?: 'weights' | 'deploy' }) {
  const { t } = useTranslation()
  const showWeights = mode === 'weights'
  const showDeploy = mode === 'deploy'
  const [latestModel, setLatestModel] = useState<ModelVersion | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  // True from workflow start until the Step Function reaches a terminal state. Keeps
  // the UI honestly showing "running" for the full ~15-20 min download/encrypt/upload
  // instead of appearing done the instant StartExecution returns.
  const [workflowRunning, setWorkflowRunning] = useState(false)
  const [workflowStatus, setWorkflowStatus] = useState<string | null>(null)
  const [workflowProgress, setWorkflowProgress] = useState<{ stage: string; percent: number; message: string } | null>(null)
  const [selectedVersion, setSelectedVersion] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    loadLatestModel()
  }, [])

  const loadLatestModel = async () => {
    try {
      const value = await getParameter('/boltz/models/latest')
      if (value) {
        setLatestModel(JSON.parse(value))
      }
    } catch (err) {
      console.warn('Failed to load latest model info:', err)
    }
  }

  // Stops any in-flight reload poll loop when the component unmounts, so we do not call
  // setState on an unmounted component. Shared by the deploy handler and the resume-on-mount
  // effect below.
  const reloadCancelled = useRef(false)
  useEffect(() => () => { reloadCancelled.current = true }, [])

  const buildAuthHeaders = async (): Promise<Record<string, string>> => {
    // /api/v1/* is behind the Cognito JWT authorizer; attach the signed-in user's ID token.
    const session = await fetchAuthSession()
    const idToken = session.tokens?.idToken?.toString()
    return { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) }
  }

  // Poll GET /models/reload/status every 5s until the in-place reload reaches a terminal
  // state, driving the same progress/success/error UI. Used both right after POST /reload and
  // by the resume-on-mount effect, since the reload status lives on the backend, not in the
  // browser.
  const pollReloadStatus = (backendUrl: string, authHeaders: Record<string, string>) => {
    const poll = async () => {
      if (reloadCancelled.current) return
      try {
        const s = await fetch(`${backendUrl}/api/v1/models/reload/status`, { headers: authHeaders })
        if (s.ok) {
          const st = await s.json()
          if (st.state === 'complete') {
            setSuccess(t('models.manager.successInPlaceComplete', { hash: (st.model_hash || '').slice(0, 16) }))
            setWorkflowStatus(null)
            setWorkflowProgress(null)
            setIsLoading(false)
            return
          } else if (st.state === 'failed') {
            // Include the stage so a failure (e.g. the attested data-key decrypt) shows where.
            setError(t('models.manager.errorInPlaceFailedStage', {
              stage: st.stage || 'reload',
              message: st.message,
              defaultValue: 'In-place update failed at {{stage}}: {{message}}',
            }))
            setWorkflowStatus(null)
            setWorkflowProgress(null)
            setIsLoading(false)
            return
          }
          setWorkflowStatus(t('models.manager.statusInPlaceProgress', { status: st.message || st.state }))
          setWorkflowProgress({ stage: st.stage || 'reload', percent: st.percent ?? 0, message: st.message || '' })
        }
      } catch { /* keep polling */ }
      if (!reloadCancelled.current) setTimeout(poll, 5000)
    }
    setTimeout(poll, 5000)
  }

  // On mount (Deployments tab), reattach to a reload that is already running so a page refresh
  // does not lose the live progress view. Only a 'running' reload is surfaced; a stale
  // 'complete'/'failed' from an earlier reload is not replayed.
  useEffect(() => {
    if (!showDeploy) return
    let ignore = false
    ;(async () => {
      try {
        const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000'
        const authHeaders = await buildAuthHeaders()
        const s = await fetch(`${backendUrl}/api/v1/models/reload/status`, { headers: authHeaders })
        if (!s.ok || ignore) return
        const st = await s.json()
        if (ignore || st.state !== 'running') return
        setIsLoading(true)
        setWorkflowStatus(t('models.manager.statusInPlaceProgress', { status: st.message || st.state }))
        setWorkflowProgress({ stage: st.stage || 'reload', percent: st.percent ?? 0, message: st.message || '' })
        pollReloadStatus(backendUrl, authHeaders)
      } catch { /* no backend/attestation reachable yet: nothing to resume */ }
    })()
    return () => { ignore = true }
  }, [showDeploy])

  const startModelDownload = async () => {
    setIsLoading(true)
    setError(null)
    setSuccess(null)
    setWorkflowProgress(null)
    setWorkflowStatus(t('models.manager.statusStartingDownload'))

    try {
      const session = await fetchAuthSession()
      const sfnClient = new SFNClient({
        region: REGION,
        credentials: session.credentials!
      })

      const response = await sfnClient.send(new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        input: JSON.stringify({
          repo: 'boltz-community/boltz-1',
          version: 'main'
        })
      }))

      // Mark running for the whole workflow lifetime; poll drives it to terminal.
      // (Download+encrypt+upload of ~10 GB takes ~15-20 min.)
      if (response.executionArn) {
        setWorkflowRunning(true)
        setWorkflowStatus(t('models.manager.statusWorkflowStarted'))
        pollExecution(sfnClient, response.executionArn)
      } else {
        setError(t('models.manager.errorNoExecutionArn'))
      }
    } catch (err) {
      setError(t('models.manager.errorStartWorkflow', { message: (err as Error).message }))
      setWorkflowStatus(null)
    } finally {
      // Only the START call is done here; the workflow itself keeps running (tracked
      // by workflowRunning). Do NOT imply completion.
      setIsLoading(false)
    }
  }

  const pollExecution = async (client: SFNClient, executionArn: string) => {
    const poll = async () => {
      try {
        const response = await client.send(new DescribeExecutionCommand({
          executionArn
        }))

        // Surface fine-grained progress written by the CodeBuild worker to SSM
        // (download → encrypt → upload), independent of the coarse SFN status.
        let progressSuffix = ''
        try {
          const p = await getModelProgress()
          if (p) {
            setWorkflowProgress({ stage: p.stage, percent: p.percent, message: p.message })
            progressSuffix = ` — ${p.stage} ${p.percent}%: ${p.message}`
          }
        } catch { /* progress is best-effort */ }

        if (response.status === 'RUNNING') {
          setWorkflowStatus(t('models.manager.statusWorkflowRunning', { progressSuffix }))
          setTimeout(poll, 5000)
        } else if (response.status === 'SUCCEEDED') {
          setWorkflowRunning(false)
          setWorkflowStatus(t('models.manager.statusWorkflowCompleted', { progressSuffix }))
          setSuccess(t('models.manager.successDownloadEncrypted'))
          loadLatestModel()
        } else {
          setWorkflowRunning(false)
          setError(t('models.manager.errorWorkflowFailed', { status: response.status, progressSuffix }))
          setWorkflowStatus(null)
        }
      } catch (err) {
        console.error('Poll error:', err)
      }
    }

    setTimeout(poll, 3000)
  }

  const deployModel = async () => {
    if (!selectedVersion && !latestModel) {
      setError(t('models.manager.errorNoVersionSelected'))
      return
    }

    setIsLoading(true)
    setError(null)
    setSuccess(null)

    try {
      const session = await fetchAuthSession()
      
      // In-place hot-reload of the attested backend's model. This is the only deployment
      // path in the UI: fleet recycle (AMI swap + instance refresh) is owned by the deploy
      // pipeline and its Step Functions state machine, not the browser.
      setWorkflowStatus(t('models.manager.statusTriggeringInPlace'))

      const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000'
      // /api/v1/* is protected by the Cognito JWT authorizer on API Gateway;
      // attach the signed-in user's ID token or the gateway returns 401.
      const idToken = session.tokens?.idToken?.toString()
      const authHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      }
      // Reload is async (weights are multi-GB, longer than the API GW 30s
      // timeout): POST returns 202, then poll /models/reload/status.
      const response = await fetch(`${backendUrl}/api/v1/models/reload`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          version: selectedVersion || latestModel?.version,
          s3_path: latestModel?.s3_path
        })
      })

      if (!response.ok) {
        throw new Error(t('models.manager.errorBackendReloadFailed'))
      }
      setWorkflowStatus(t('models.manager.statusInPlaceStarted'))
      // The reload runs in the background; keep isLoading true so the button stays disabled
      // and the status persists until the poll reaches a terminal state.
      pollReloadStatus(backendUrl, authHeaders)
      return  // keep the "started" status; poll owns the lifecycle from here
    } catch (err) {
      setError(t('models.manager.errorDeploymentFailed', { message: (err as Error).message }))
      setWorkflowStatus(null)
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {showWeights ? t('models.manager.headerWeights') : t('models.manager.headerDeploy')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {showWeights
              ? t('models.manager.descWeights')
              : t('models.manager.descDeploy')}
          </p>
        </div>
      </div>

      {/* Current Model Info (shown on both tabs — the shared reference point) */}
      <div className="card">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          {t('models.manager.currentModelHeading')}
        </h3>
        
        {latestModel && latestModel.version !== 'v0' ? (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className="text-sm text-gray-500 dark:text-gray-400">{t('models.manager.labelVersion')}</span>
              <p className="font-mono text-gray-900 dark:text-gray-100">{latestModel.version}</p>
            </div>
            <div>
              <span className="text-sm text-gray-500 dark:text-gray-400">{t('models.manager.labelCreated')}</span>
              <p className="text-gray-900 dark:text-gray-100">
                {new Date(latestModel.created_at).toLocaleString()}
              </p>
            </div>
            <div className="col-span-2">
              <span className="text-sm text-gray-500 dark:text-gray-400">{t('models.manager.labelS3Path')}</span>
              <p className="font-mono text-sm text-gray-900 dark:text-gray-100 break-all">
                {latestModel.s3_path || t('models.manager.valueNotSet')}
              </p>
            </div>
            <div className="col-span-2">
              <span className="text-sm text-gray-500 dark:text-gray-400">{t('models.manager.labelSha384Hash')}</span>
              <p className="font-mono text-xs text-gray-900 dark:text-gray-100 break-all">
                {latestModel.hash || t('models.manager.valueNotComputed')}
              </p>
            </div>
          </div>
        ) : (
          <div className="text-center py-6 text-gray-500 dark:text-gray-400">
            <p>{t('models.manager.noModelConfigured')}</p>
            <p className="text-sm mt-1">{t('models.manager.downloadToStart')}</p>
          </div>
        )}
      </div>

      {/* Download Section (Model Weights tab only) */}
      {showWeights && (
      <div className="card">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          {t('models.manager.downloadHeading')}
        </h3>
        
        <div className="space-y-4">
          <div className="flex items-center gap-4 p-4 bg-blue-50 dark:bg-blue-900/30 rounded-lg">
            <span className="text-2xl">🤗</span>
            <div className="flex-1">
              <p className="font-medium text-gray-900 dark:text-gray-100">{/* nosemgrep: jsx-not-internationalized */}
                boltz-community/boltz-1
              </p>
              <a 
                href="https://huggingface.co/boltz-community/boltz-1/tree/main"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
              >
                {t('models.manager.linkViewHuggingFace')}
              </a>
            </div>
            <button
              onClick={startModelDownload}
              disabled={isLoading || workflowRunning}
              className="btn btn-primary"
            >
              {isLoading || workflowRunning ? (
                <>
                  <span className="animate-spin mr-2">⏳</span>
                  {workflowRunning ? t('models.manager.btnRunning') : t('models.manager.btnStarting')}
                </>
              ) : (
                <>{t('models.manager.btnDownloadEncrypt')}</>
              )}
            </button>
          </div>
        </div>
      </div>
      )}

      {/* Deployment Section (Deployments tab only) */}
      {showDeploy && (
      <div className="card">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          {t('models.manager.deployHeading')}
        </h3>
        
        <div className="space-y-4">
          {/* Version Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('models.manager.labelSelectVersion')}
            </label>
            <select
              value={selectedVersion}
              onChange={(e) => setSelectedVersion(e.target.value)}
              className="input w-full"
            >
              <option value="">{t('models.manager.optionLatest', { version: latestModel?.version || t('models.manager.optionNone') })}</option>
              {/* Additional versions would be listed here */}
            </select>
          </div>

          {/* In-place is the only deployment path in the UI: the browser hot-reloads the
              attested backend's model. Fleet recycle (AMI swap + instance refresh) is owned by
              the deploy pipeline and its Step Functions state machine, not the browser. */}
          <div className="p-4 rounded-lg border-2 border-green-500 bg-green-50 dark:bg-green-900/30">
            <div className="flex items-center gap-3 mb-2">
              <span className="text-2xl">🔄</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {t('models.manager.strategyInPlaceTitle')}
              </span>
            </div>
            <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
              <li>{t('models.manager.strategyInPlaceItem1')}</li>
              <li>{t('models.manager.strategyInPlaceItem2')}</li>
              <li>{t('models.manager.strategyInPlaceItem3')}</li>
              <li>{t('models.manager.strategyInPlaceItem4')}</li>
            </ul>
          </div>

          {/* Deploy Button */}
          <button
            onClick={deployModel}
            disabled={isLoading || (!latestModel && !selectedVersion)}
            className="btn w-full py-3 bg-green-600 hover:bg-green-700 text-white"
          >
            {isLoading ? (
              <>
                <span className="animate-spin mr-2">⏳</span>
                {t('models.manager.btnDeploying')}
              </>
            ) : (
              <>{t('models.manager.btnDeployInPlace')}</>
            )}
          </button>

          <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
            {t('models.manager.deployWarning')}
          </p>
        </div>
      </div>
      )}

      {/* Progress overlay (shared by both tabs): the produce workflow (weights) and the
          in-place reload (deployments) both drive workflowStatus/workflowProgress. Rendered
          as a fixed toast so it stays visible regardless of scroll position; it clears when
          the flow reaches a terminal state (success/error banners take over). */}
      {workflowStatus && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 right-4 z-50 w-96 max-w-[calc(100vw-2rem)] p-4 bg-yellow-50 dark:bg-yellow-900 border border-yellow-300 dark:border-yellow-700 rounded-lg shadow-2xl"
        >
          <p className="text-sm font-medium text-yellow-900 dark:text-yellow-100 flex items-center gap-2">
            <span className="animate-spin">⏳</span>
            <span>{workflowStatus}</span>
          </p>
          {workflowProgress && (
            <div className="mt-2">
              <div className="flex justify-between text-xs text-yellow-800 dark:text-yellow-200 mb-1">
                <span className="truncate mr-2">{workflowProgress.stage}: {workflowProgress.message}</span>
                <span className="font-semibold shrink-0">{workflowProgress.percent}%</span>
              </div>
              <div className="h-2 bg-yellow-200 dark:bg-yellow-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-yellow-500 transition-all"
                  style={{ width: `${workflowProgress.percent}%` }}
                />
              </div>
            </div>
          )}
          {workflowRunning && (
            <p className="text-xs text-yellow-700 dark:text-yellow-300 mt-2">
              {t('models.manager.downloadHint')}
            </p>
          )}
        </div>
      )}

      {/* Status Messages */}
      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg">
          <p className="text-red-800 dark:text-red-200">❌ {error}</p>
        </div>
      )}
      
      {success && (
        <div className="p-4 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700 rounded-lg">
          <p className="text-green-800 dark:text-green-200">✅ {success}</p>
        </div>
      )}
    </div>
  )
}