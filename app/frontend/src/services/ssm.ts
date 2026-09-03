import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm'
import { fetchAuthSession } from 'aws-amplify/auth'

const REGION = import.meta.env.VITE_AWS_REGION || 'us-east-1'

// Get authenticated SSM client
async function getSSMClient(): Promise<SSMClient> {
  const session = await fetchAuthSession()
  
  if (!session.credentials) {
    throw new Error('No credentials available. Please sign in.')
  }

  return new SSMClient({
    region: REGION,
    credentials: session.credentials,
  })
}

export interface ModelProgress {
  version_id: string
  stage: string // starting | downloading | encrypting | complete | failed
  percent: number
  message: string
  updated_at: string
  s3_path?: string
  hash?: string
}

/**
 * Read the latest model-workflow progress from SSM
 * (/boltz/models/progress/latest), written by the CodeBuild worker as it
 * downloads → encrypts → uploads the Boltz weights. Returns null if not present.
 */
export async function getModelProgress(): Promise<ModelProgress | null> {
  const client = await getSSMClient()
  try {
    const response = await client.send(
      new GetParameterCommand({ Name: '/boltz/models/progress/latest' })
    )
    if (!response.Parameter?.Value) return null
    return JSON.parse(response.Parameter.Value) as ModelProgress
  } catch (error) {
    if ((error as Error).name === 'ParameterNotFound') return null
    throw error
  }
}

// NOTE: The PCR trust store used to live here (SSM Parameter Store). It has moved to
// the browser (services/trustStore.ts): the client's "PCRs I trust" baseline must not
// be stored in a backend the client is trying to attest. Only backend-owned reads
// (model-download progress) and generic helpers remain in this SSM service.

// Generic get parameter (for notifications, etc.)
export async function getParameter(name: string): Promise<string | null> {
  const client = await getSSMClient()
  
  try {
    const command = new GetParameterCommand({
      Name: name,
      WithDecryption: false,
    })
    
    const response = await client.send(command)
    return response.Parameter?.Value || null
  } catch (error) {
    if ((error as Error).name === 'ParameterNotFound') {
      return null
    }
    throw error
  }
}

// Generic put parameter (for notifications, etc.)
export async function putParameter(name: string, value: string): Promise<void> {
  const client = await getSSMClient()
  
  const command = new PutParameterCommand({
    Name: name,
    Value: value,
    Type: 'String',
    Overwrite: true,
  })
  
  await client.send(command)
}
