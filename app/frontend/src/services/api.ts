import { fetchAuthSession } from 'aws-amplify/auth'

/**
 * Get the JWT ID token for authenticated API calls
 */
export async function getIdToken(): Promise<string | null> {
  try {
    const session = await fetchAuthSession()
    const token = session.tokens?.idToken?.toString()
    return token || null
  } catch (error) {
    console.error('Failed to get auth token:', error)
    return null
  }
}

/**
 * Get the backend URL from localStorage
 */
export function getBackendUrl(): string {
  return localStorage.getItem('backendUrl') || import.meta.env.VITE_BACKEND_URL || ''
}

/**
 * Make an authenticated API request
 */
export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const backendUrl = getBackendUrl()
  if (!backendUrl) {
    throw new Error('No backend URL configured')
  }

  const token = await getIdToken()
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  // Merge existing headers
  if (options.headers) {
    const existingHeaders = options.headers as Record<string, string>
    Object.assign(headers, existingHeaders)
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const response = await fetch(`${backendUrl}${endpoint}`, {
    ...options,
    headers,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`)
  }

  return response.json()
}

/**
 * Make an authenticated API request that returns a blob (for downloads)
 */
export async function apiBlobRequest(
  endpoint: string,
  options: RequestInit = {}
): Promise<Blob> {
  const backendUrl = getBackendUrl()
  if (!backendUrl) {
    throw new Error('No backend URL configured')
  }

  const token = await getIdToken()
  
  const headers: Record<string, string> = {}

  // Merge existing headers
  if (options.headers) {
    const existingHeaders = options.headers as Record<string, string>
    Object.assign(headers, existingHeaders)
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const response = await fetch(`${backendUrl}${endpoint}`, {
    ...options,
    headers,
  })

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`)
  }

  return response.blob()
}