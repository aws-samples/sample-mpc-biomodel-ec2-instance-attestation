import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelVersion } from '../../types'
import { getIdToken } from '../../services/api'

interface ModelDeploymentProps {
  models: ModelVersion[]
  onDeploy?: (modelId: string) => void
  onActivate?: (modelId: string) => void
}

export function ModelDeployment({ models, onDeploy, onActivate }: ModelDeploymentProps) {
  const { t } = useTranslation()
  const [selectedModel, setSelectedModel] = useState<ModelVersion | null>(null)
  const [isDeploying, setIsDeploying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [backendUrl, setBackendUrl] = useState('')

  useEffect(() => {
    const stored = localStorage.getItem('backendUrl')
    if (stored) setBackendUrl(stored)
  }, [])

  // Get status badge color
  const getStatusBadge = (status: ModelVersion['status']) => {
    switch (status) {
      case 'active':
        return 'badge-success'
      case 'deploying':
        return 'badge-info'
      case 'validating':
        return 'badge-warning'
      case 'failed':
        return 'badge-error'
      case 'inactive':
        return 'badge-secondary'
      default:
        return 'badge-secondary'
    }
  }

  // Deploy model
  const handleDeploy = async (model: ModelVersion) => {
    if (!backendUrl) {
      setError(t('models.deployment.noBackendConnect'))
      return
    }

    setIsDeploying(true)
    setError(null)

    try {
      const token = await getIdToken()
      const response = await fetch(`${backendUrl}/api/v1/models/deploy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          model_id: model.id,
          s3_key: model.s3_key,
          name: model.name,
          version: model.version,
          checksum: model.checksum,
        }),
      })

      if (!response.ok) {
        throw new Error(t('models.deployment.deploymentFailedStatus', { status: response.statusText }))
      }

      onDeploy?.(model.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('models.deployment.deploymentFailed'))
    } finally {
      setIsDeploying(false)
    }
  }

  // Activate model
  const handleActivate = async (model: ModelVersion) => {
    if (!backendUrl) {
      setError(t('models.deployment.noBackend'))
      return
    }

    setIsDeploying(true)
    setError(null)

    try {
      const token = await getIdToken()
      const response = await fetch(`${backendUrl}/api/v1/models/activate/${model.id}`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })

      if (!response.ok) {
        throw new Error(t('models.deployment.activationFailedStatus', { status: response.statusText }))
      }

      onActivate?.(model.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('models.deployment.activationFailed'))
    } finally {
      setIsDeploying(false)
    }
  }

  // Format date
  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString()
  }

  // Format file size
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  const pendingModels = models.filter(m => m.status === 'uploading' || m.status === 'validating')
  const deployedModels = models.filter(m => m.status === 'active' || m.status === 'inactive' || m.status === 'deploying')
  const failedModels = models.filter(m => m.status === 'failed')

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('models.deployment.title')}</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">
          {t('models.deployment.subtitle')}
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="card bg-red-50 dark:bg-red-900 border-red-200 dark:border-red-800">
          <div className="flex items-center gap-3 text-red-700 dark:text-red-300">
            <span className="text-xl">⚠️</span>
            <p>{error}</p>
          </div>
        </div>
      )}

      {/* Backend Status */}
      <div className="card">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`w-3 h-3 rounded-full ${backendUrl ? 'bg-green-500' : 'bg-gray-400'}`}></span>
            <span className="text-sm text-gray-600 dark:text-gray-400">
              {backendUrl ? t('models.deployment.connectedTo', { backendUrl }) : t('models.deployment.noBackendConnected')}
            </span>
          </div>
          {!backendUrl && (
            <a href="/biophysicist/connect" className="btn btn-secondary btn-sm">
              {t('models.deployment.connectBackend')}
            </a>
          )}
        </div>
      </div>

      {/* Pending Models */}
      {pendingModels.length > 0 && (
        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('models.deployment.readyToDeploy')}
          </h2>
          <div className="space-y-3">
            {pendingModels.map(model => (
              <div key={model.id} className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-medium text-gray-900 dark:text-gray-100">{model.name}</h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      v{model.version} • {formatSize(model.size_bytes)} • {formatDate(model.created_at)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`badge ${getStatusBadge(model.status)}`}>
                      {model.status}
                    </span>
                    <button
                      onClick={() => handleDeploy(model)}
                      disabled={isDeploying || !backendUrl}
                      className="btn btn-primary btn-sm"
                    >
                      {isDeploying ? (
                        <span className="spinner-small"></span>
                      ) : (
                        t('models.deployment.deployButton')
                      )}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Deployed Models */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('models.deployment.deployedModels')}
        </h2>
        {deployedModels.length === 0 ? (
          <div className="text-center py-8">
            <span className="text-4xl mb-4 block">📦</span>
            <p className="text-gray-500 dark:text-gray-400">{t('models.deployment.noDeployedModels')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {deployedModels.map(model => (
              <div 
                key={model.id} 
                onClick={() => setSelectedModel(model)}
                className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                  model.is_active 
                    ? 'border-green-300 bg-green-50 dark:bg-green-900'
                    : 'border-gray-200 dark:border-gray-700 hover:border-gray-300'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-gray-900 dark:text-gray-100">{model.name}</h3>
                      {model.is_active && (
                        <span className="text-xs bg-green-500 text-white px-2 py-0.5 rounded-full">
                          {t('models.deployment.activeBadge')}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      v{model.version} • {formatSize(model.size_bytes)}
                    </p>
                    <p className="text-xs text-gray-400">
                      {t('models.deployment.deployedLabel')} {model.deployed_at ? formatDate(model.deployed_at) : t('models.deployment.pending')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`badge ${getStatusBadge(model.status)}`}>
                      {model.status}
                    </span>
                    {!model.is_active && model.status === 'inactive' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleActivate(model)
                        }}
                        disabled={isDeploying}
                        className="btn btn-secondary btn-sm"
                      >
                        {t('models.deployment.activate')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Failed Models */}
      {failedModels.length > 0 && (
        <div className="card bg-red-50 dark:bg-red-900 border-red-200 dark:border-red-800">
          <h2 className="text-lg font-semibold text-red-900 dark:text-red-100 mb-4">
            {t('models.deployment.failedDeployments')}
          </h2>
          <div className="space-y-3">
            {failedModels.map(model => (
              <div key={model.id} className="p-4 bg-white dark:bg-gray-800 border border-red-200 dark:border-red-800 rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-medium text-gray-900 dark:text-gray-100">{model.name}</h3>
                    <p className="text-sm text-red-600 dark:text-red-300">{model.error_message}</p>
                  </div>
                  <button
                    onClick={() => handleDeploy(model)}
                    disabled={isDeploying}
                    className="btn btn-secondary btn-sm"
                  >
                    {t('models.deployment.retry')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Selected Model Details */}
      {selectedModel && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('models.deployment.modelDetails')}
            </h2>
            <button
              onClick={() => setSelectedModel(null)}
              className="text-gray-400 hover:text-gray-600"
            >
              ✕
            </button>
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">{t('models.deployment.labelName')}</label>
              <p className="text-gray-900 dark:text-gray-100">{selectedModel.name}</p>
            </div>
            <div>
              <label className="label">{t('models.deployment.labelVersion')}</label>
              <p className="text-gray-900 dark:text-gray-100">{selectedModel.version}</p>
            </div>
            <div>
              <label className="label">{t('models.deployment.labelSize')}</label>
              <p className="text-gray-900 dark:text-gray-100">{formatSize(selectedModel.size_bytes)}</p>
            </div>
            <div>
              <label className="label">{t('models.deployment.labelStatus')}</label>
              <span className={`badge ${getStatusBadge(selectedModel.status)}`}>
                {selectedModel.status}
              </span>
            </div>
            <div className="col-span-2">
              <label className="label">{t('models.deployment.labelS3Key')}</label>
              <p className="font-mono text-xs text-gray-600 dark:text-gray-400 break-all">{selectedModel.s3_key}</p>
            </div>
            <div className="col-span-2">
              <label className="label">{t('models.deployment.labelChecksum')}</label>
              <p className="font-mono text-xs text-gray-600 dark:text-gray-400 break-all">{selectedModel.checksum}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}