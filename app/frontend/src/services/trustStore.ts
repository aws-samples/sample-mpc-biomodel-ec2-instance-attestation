import type { TrustStoreEntry, UserRole } from '../types'
import { normalizePcrValues } from '../types'

/**
 * Client-side PCR trust store — persisted in the BROWSER (localStorage), not in a
 * backend SSM parameter.
 *
 * Rationale: the trust store is the client's own record of "these are the PCR
 * measurements I have inspected and chosen to trust." Keeping it in a backend-owned
 * SSM parameter forces the client to trust the very service it is trying to attest
 * (and expands the trust boundary to a backend it does not control and cannot see
 * into). The baseline a client compares against must live on the client. localStorage
 * is origin-scoped and not readable by the backend, so it keeps the trust decision
 * where it belongs.
 *
 * Storage layout: one JSON entry per role+environment under a namespaced key.
 * This is a drop-in replacement for the getTrustStore/saveTrustStore SSM functions.
 */

const KEY_PREFIX = 'boltz.trustStore'

function storageKey(role: UserRole, environment: string): string {
  return `${KEY_PREFIX}.${role}.${environment}`
}

/** Read the trust store for a role/environment from browser storage (null if none). */
export function getTrustStore(role: UserRole, environment: string = 'prod'): TrustStoreEntry | null {
  try {
    const raw = localStorage.getItem(storageKey(role, environment))
    if (!raw) return null
    const data = JSON.parse(raw)
    return {
      environment,
      pcr_values: normalizePcrValues(data.pcr_values || {}),
      last_updated: data.last_updated || '',
      updated_by: data.updated_by,
    }
  } catch (e) {
    console.warn('Failed to read trust store from browser storage:', e)
    return null
  }
}

/** Persist the trust store for a role/environment to browser storage. */
export function saveTrustStore(
  role: UserRole,
  pcrValues: Record<string, string>,
  updatedBy: string,
  environment: string = 'prod'
): TrustStoreEntry {
  const entry: TrustStoreEntry = {
    environment,
    pcr_values: normalizePcrValues(pcrValues),
    last_updated: new Date().toISOString(),
    updated_by: updatedBy,
  }
  localStorage.setItem(
    storageKey(role, environment),
    JSON.stringify({
      pcr_values: entry.pcr_values,
      last_updated: entry.last_updated,
      updated_by: entry.updated_by,
    })
  )
  return entry
}

/** Remove the trust store for a role/environment (e.g. to reset the baseline). */
export function clearTrustStore(role: UserRole, environment: string = 'prod'): void {
  localStorage.removeItem(storageKey(role, environment))
}
