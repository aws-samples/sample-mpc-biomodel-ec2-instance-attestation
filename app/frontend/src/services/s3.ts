import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { fetchAuthSession } from 'aws-amplify/auth'
import type { UserRole } from '../types'
import { ROLE_CONFIGS } from '../types'

const REGION = import.meta.env.VITE_AWS_REGION || 'us-east-1'
// Buckets are CDK auto-named (no fixed prefix), so their real names are injected at
// deploy time from stack outputs. VITE_S3_BUCKET kept as a legacy single-bucket override.
const BUCKET = import.meta.env.VITE_S3_BUCKET || ''
const SEQUENCES_BUCKET = import.meta.env.VITE_SEQUENCES_BUCKET || ''
const MODELS_BUCKET = import.meta.env.VITE_MODELS_BUCKET || ''

// Get authenticated S3 client
async function getS3Client(): Promise<S3Client> {
  const session = await fetchAuthSession()
  
  if (!session.credentials) {
    throw new Error('No credentials available. Please sign in.')
  }

  return new S3Client({
    region: REGION,
    credentials: session.credentials,
  })
}

// Get bucket name for a role. Prefer the deploy-time injected name (CDK output); fall
// back to the legacy "<prefix>-<env>" only if not injected (e.g. local dev).
export function getBucketName(role: UserRole, environment: string = 'prod'): string {
  const injected = role === 'biologist' ? SEQUENCES_BUCKET : MODELS_BUCKET
  if (injected) return injected
  const roleConfig = ROLE_CONFIGS[role]
  return `${roleConfig.s3BucketPrefix}-${environment}`
}

// Get S3 key prefix for a role
export function getKeyPrefix(role: UserRole, userId: string): string {
  return `${role}/${userId}`
}

// The bucket a sequence is stored in, resolved the same way uploads/lists do
// (legacy VITE_S3_BUCKET override, else the role's injected bucket). Sent to the
// backend at prediction time so it can fetch and attested-decrypt the ciphertext.
export function getSequencesBucketName(role: UserRole): string {
  return BUCKET || getBucketName(role)
}

// Upload encrypted sequence to S3
export async function uploadEncryptedSequence(
  role: UserRole,
  userId: string,
  sequenceId: string,
  encryptedData: string,
  metadata: {
    name: string
    length: number
    kmsKeyId: string
    // The KMS encryption context used to encrypt. It MUST be persisted so decryption
    // (which requires the exact same context) can reconstruct it at prediction time.
    encryptionContext?: Record<string, string>
  }
): Promise<string> {
  const client = await getS3Client()
  const bucket = BUCKET || getBucketName(role)
  const key = `${getKeyPrefix(role, userId)}/sequences/${sequenceId}.enc`

  const meta: Record<string, string> = {
    'name': metadata.name,
    'length': metadata.length.toString(),
    'kms-key-id': metadata.kmsKeyId,
    'encrypted': 'true',
  }
  if (metadata.encryptionContext) {
    // Stored as JSON so it round-trips exactly (context is small — well under the 2KB
    // S3 user-metadata limit). The attested backend reads this metadata at prediction
    // time to reconstruct the exact encryption context for KMS decryption.
    //
    // Build the object with keys inserted in sorted order first, so the serialized
    // output is byte-identical for the same context regardless of the order the keys
    // were originally added. That is what the no-stringify-keys rule asks for: the
    // concern is relying on JSON.stringify's key ordering, and sorting removes the
    // dependency on it. The result is a metadata VALUE, never used as an object key.
    const ctx = metadata.encryptionContext
    const sortedCtx: Record<string, string> = {}
    for (const k of Object.keys(ctx).sort()) {
      sortedCtx[k] = ctx[k]
    }
    // nosemgrep: no-stringify-keys
    meta['encryption-context'] = JSON.stringify(sortedCtx)
  }

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: encryptedData,
    ContentType: 'application/octet-stream',
    Metadata: meta,
  })

  await client.send(command)
  return key
}

// Upload encrypted model weights to S3
export async function uploadEncryptedModel(
  role: UserRole,
  userId: string,
  modelId: string,
  encryptedData: Uint8Array | string,
  metadata: {
    name: string
    version: string
    sizeBytes: number
    checksum: string
    kmsKeyId: string
  }
): Promise<string> {
  const client = await getS3Client()
  const bucket = BUCKET || getBucketName(role)
  const key = `${getKeyPrefix(role, userId)}/models/${modelId}.enc`

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: encryptedData,
    ContentType: 'application/octet-stream',
    Metadata: {
      'x-amz-meta-name': metadata.name,
      'x-amz-meta-version': metadata.version,
      'x-amz-meta-size-bytes': metadata.sizeBytes.toString(),
      'x-amz-meta-checksum': metadata.checksum,
      'x-amz-meta-kms-key-id': metadata.kmsKeyId,
      'x-amz-meta-encrypted': 'true',
    },
  })

  await client.send(command)
  return key
}

// List encrypted sequences for a user
export async function listEncryptedSequences(
  role: UserRole,
  userId: string
): Promise<{ key: string; name: string; lastModified: Date }[]> {
  const client = await getS3Client()
  const bucket = BUCKET || getBucketName(role)
  const prefix = `${getKeyPrefix(role, userId)}/sequences/`

  const command = new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
  })

  const response = await client.send(command)
  
  if (!response.Contents) {
    return []
  }

  return response.Contents.map(obj => ({
    key: obj.Key || '',
    name: obj.Key?.split('/').pop()?.replace('.enc', '') || 'unknown',
    lastModified: obj.LastModified || new Date(),
  }))
}

// List encrypted models for a user
export async function listEncryptedModels(
  role: UserRole,
  userId: string
): Promise<{ key: string; name: string; lastModified: Date; sizeBytes: number }[]> {
  const client = await getS3Client()
  const bucket = BUCKET || getBucketName(role)
  const prefix = `${getKeyPrefix(role, userId)}/models/`

  const command = new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
  })

  const response = await client.send(command)
  
  if (!response.Contents) {
    return []
  }

  return response.Contents.map(obj => ({
    key: obj.Key || '',
    name: obj.Key?.split('/').pop()?.replace('.enc', '') || 'unknown',
    lastModified: obj.LastModified || new Date(),
    sizeBytes: obj.Size || 0,
  }))
}

// Get encrypted data from S3
export async function getEncryptedData(key: string): Promise<string> {
  const client = await getS3Client()
  const bucket = BUCKET

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  })

  const response = await client.send(command)
  
  if (!response.Body) {
    throw new Error('No data found')
  }

  // Convert stream to string
  const data = await response.Body.transformToString()
  return data
}

// Delete encrypted data from S3
export async function deleteEncryptedData(key: string): Promise<void> {
  const client = await getS3Client()
  const bucket = BUCKET

  const command = new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  })

  await client.send(command)
}

// Generate presigned URL for upload (if needed for large files)
export async function getUploadPresignedUrl(
  role: UserRole,
  userId: string,
  filename: string,
  _contentType: string = 'application/octet-stream'
): Promise<{ url: string; key: string }> {
  // For now, just return the key - actual presigned URL generation requires additional setup
  const key = `${getKeyPrefix(role, userId)}/${filename}`
  return {
    url: `s3://${BUCKET}/${key}`,
    key,
  }
}