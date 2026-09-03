import { useState, useRef } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthProvider'
import { useRole } from '../../contexts/RoleContext'
import { encryptData } from '../../services/kms'
import { uploadEncryptedModel } from '../../services/s3'
import type { ModelVersion } from '../../types'

interface ModelWeightsUploadProps {
  onUploadComplete?: (modelVersion: ModelVersion) => void
}

export function ModelWeightsUpload({ onUploadComplete }: ModelWeightsUploadProps) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { roleConfig } = useRole()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [file, setFile] = useState<File | null>(null)
  const [modelName, setModelName] = useState('')
  const [modelVersion, setModelVersion] = useState('')
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadStage, setUploadStage] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [uploadResult, setUploadResult] = useState<{
    s3Key: string
    checksum: string
    sizeBytes: number
  } | null>(null)

  const kmsKeyAlias = roleConfig?.kmsKeyAlias || 'alias/boltz-model-key'

  // Handle file selection
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]
    if (selectedFile) {
      setFile(selectedFile)
      setUploadResult(null)
      setError(null)

      // Auto-populate name from filename
      if (!modelName) {
        const baseName = selectedFile.name.replace(/\.[^/.]+$/, '')
        setModelName(baseName)
      }
    }
  }

  // Calculate file checksum
  const calculateChecksum = async (data: ArrayBuffer): Promise<string> => {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  }

  // Handle upload
  const handleUpload = async () => {
    if (!file || !modelName || !modelVersion) {
      setError(t('models.weights-upload.errorFillFields'))
      return
    }

    if (!user?.sub) {
      setError(t('models.weights-upload.errorNotAuthenticated'))
      return
    }

    setIsUploading(true)
    setError(null)
    setUploadProgress(0)

    try {
      // Stage 1: Read file
      setUploadStage(t('models.weights-upload.stageReadingFile'))
      setUploadProgress(10)
      
      const fileBuffer = await file.arrayBuffer()
      const fileData = new Uint8Array(fileBuffer)
      
      // Stage 2: Calculate checksum
      setUploadStage(t('models.weights-upload.stageCalculatingChecksum'))
      setUploadProgress(25)
      
      const checksum = await calculateChecksum(fileBuffer)

      // Stage 3: Encrypt
      setUploadStage(t('models.weights-upload.stageEncrypting'))
      setUploadProgress(40)
      
      // For large files, we'd use chunked encryption
      // For now, convert to base64 and encrypt
      const base64Data = btoa(String.fromCharCode(...fileData))
      const encryptedData = await encryptData(kmsKeyAlias, base64Data)

      // Stage 4: Upload to S3
      setUploadStage(t('models.weights-upload.stageUploading'))
      setUploadProgress(70)

      const modelId = crypto.randomUUID()
      const s3Key = await uploadEncryptedModel(
        'biophysicist',
        user.sub,
        modelId,
        encryptedData,
        {
          name: modelName,
          version: modelVersion,
          sizeBytes: file.size,
          checksum,
          kmsKeyId: kmsKeyAlias,
        }
      )

      // Stage 5: Complete
      setUploadStage(t('models.weights-upload.stageComplete'))
      setUploadProgress(100)

      const result = {
        s3Key,
        checksum,
        sizeBytes: file.size,
      }
      setUploadResult(result)

      // Create model version object
      const newModel: ModelVersion = {
        id: modelId,
        name: modelName,
        version: modelVersion,
        status: 'uploading',
        s3_key: s3Key,
        size_bytes: file.size,
        checksum,
        created_at: new Date().toISOString(),
        is_active: false,
      }

      onUploadComplete?.(newModel)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('models.weights-upload.errorUploadFailed'))
    } finally {
      setIsUploading(false)
    }
  }

  // Format file size
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  return (
    <div className="space-y-6">
      {/* Upload Form */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          📦 {t('models.weights-upload.title')}
        </h2>

        {/* Model Name */}
        <div className="mb-4">
          <label className="label">{t('models.weights-upload.modelNameLabel')} <span className="text-red-500">*</span></label>
          <input
            type="text"
            className="input"
            placeholder={t('models.weights-upload.modelNamePlaceholder')}
            value={modelName}
            onChange={e => setModelName(e.target.value)}
          />
        </div>

        {/* Model Version */}
        <div className="mb-4">
          <label className="label">{t('models.weights-upload.versionLabel')} <span className="text-red-500">*</span></label>
          <input
            type="text"
            className="input"
            placeholder={t('models.weights-upload.versionPlaceholder')}
            value={modelVersion}
            onChange={e => setModelVersion(e.target.value)}
          />
        </div>

        {/* File Input */}
        <div className="mb-4">
          <label className="label">{t('models.weights-upload.fileLabel')} <span className="text-red-500">*</span></label>
          <div
            onClick={() => fileInputRef.current?.click()}
            className={`
              border-2 border-dashed rounded-lg p-8 text-center cursor-pointer
              transition-colors
              ${file
                ? 'border-green-300 bg-green-50 dark:bg-green-900'
                : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'}
            `}
          >
            {file ? (
              <div>
                <span className="text-3xl mb-2 block">📄</span>
                <p className="font-medium text-gray-900 dark:text-gray-100">{file.name}</p>
                <p className="text-sm text-gray-500 dark:text-gray-400">{formatSize(file.size)}</p>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setFile(null)
                    if (fileInputRef.current) fileInputRef.current.value = ''
                  }}
                  className="mt-2 text-sm text-red-600 dark:text-red-300 hover:text-red-800"
                >
                  {t('models.weights-upload.removeButton')}
                </button>
              </div>
            ) : (
              <div>
                <span className="text-3xl mb-2 block">📁</span>
                <p className="text-gray-600 dark:text-gray-400">{t('models.weights-upload.clickToSelect')}</p>
                <p className="text-sm text-gray-400 dark:text-gray-400 mt-1">
                  {t('models.weights-upload.supportedFormats')}
                </p>
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".pt,.pth,.ckpt,.safetensors,.bin"
            onChange={handleFileSelect}
          />
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {/* Upload Progress */}
        {isUploading && (
          <div className="mb-4">
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-600 dark:text-gray-400">{uploadStage}</span>
              <span className="font-medium">{uploadProgress}%</span>
            </div>
            <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div 
                className="h-full bg-purple-500 transition-all duration-300"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* Upload Button */}
        <button
          onClick={handleUpload}
          disabled={isUploading || !file || !modelName || !modelVersion}
          className="btn btn-primary w-full"
        >
          {isUploading ? (
            <>
              <span className="spinner-small"></span>
              {t('models.weights-upload.uploadingButton')}
            </>
          ) : (
            <>
              🔐 {t('models.weights-upload.encryptUploadButton')}
            </>
          )}
        </button>
      </div>

      {/* Upload Result */}
      {uploadResult && (
        <div className="card bg-green-50 dark:bg-green-900 border-green-200 dark:border-green-800">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-green-600 dark:text-green-300 text-xl">✓</span>
            <h3 className="text-lg font-semibold text-green-900 dark:text-green-100">
              {t('models.weights-upload.uploadSuccessTitle')}
            </h3>
          </div>

          <div className="space-y-3">
            <div>
              <label className="label">{t('models.weights-upload.s3KeyLabel')}</label>
              <p className="font-mono text-sm bg-white dark:bg-gray-800 p-2 rounded border border-green-200 dark:border-green-800 break-all">
                {uploadResult.s3Key}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">{t('models.weights-upload.sizeLabel')}</label>
                <p className="text-sm bg-white dark:bg-gray-800 p-2 rounded border border-green-200 dark:border-green-800">
                  {formatSize(uploadResult.sizeBytes)}
                </p>
              </div>
              <div>
                <label className="label">{t('models.weights-upload.checksumLabel')}</label>
                <p className="font-mono text-xs bg-white dark:bg-gray-800 p-2 rounded border border-green-200 dark:border-green-800 truncate">
                  {uploadResult.checksum}
                </p>
              </div>
            </div>
          </div>

          <p className="text-sm text-green-700 dark:text-green-300 mt-4">
            <Trans i18nKey="models.weights-upload.uploadReadyMessage">{/* nosemgrep: jsx-not-internationalized */}The model is now ready for deployment. Go to <strong>Deployments</strong> to deploy this model to the backend.</Trans>
          </p>
        </div>
      )}

      {/* Info */}
      <div className="card bg-purple-50 dark:bg-purple-900 border-purple-200 dark:border-purple-800">
        <div className="flex items-start gap-3">
          <span className="text-2xl">ℹ️</span>
          <div className="text-sm text-purple-800 dark:text-purple-200">
            <p className="font-medium mb-1">{t('models.weights-upload.infoTitle')}</p>
            <ol className="list-decimal list-inside space-y-1">
              <li><Trans i18nKey="models.weights-upload.infoKms" values={{ kmsKeyAlias }}>{/* nosemgrep: jsx-not-internationalized */}Model weights are encrypted client-side using AWS KMS: <code className="bg-purple-100 dark:bg-purple-800 px-1 rounded">{'{{kmsKeyAlias}}'}</code></Trans></li>
              <li>{t('models.weights-upload.infoChecksum')}</li>
              <li>{t('models.weights-upload.infoStored')}</li>
              <li>{t('models.weights-upload.infoAttested')}</li>
            </ol>
          </div>
        </div>
      </div>

      {/* Warning */}
      <div className="card bg-yellow-50 dark:bg-yellow-900 border-yellow-200 dark:border-yellow-800">
        <div className="flex items-start gap-3">
          <span className="text-2xl">⚠️</span>
          <div>
            <p className="font-medium text-yellow-900 dark:text-yellow-100">{t('models.weights-upload.warningTitle')}</p>
            <p className="text-sm text-yellow-800 dark:text-yellow-200 mt-1">
              {t('models.weights-upload.warningBody')}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}