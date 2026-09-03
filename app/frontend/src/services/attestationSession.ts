/**
 * Cached attestation session — persisted in the BROWSER (localStorage), keyed by role.
 *
 * A NitroTPM attestation document's leaf certificate is valid for ~3 hours. Without a cache,
 * every page refresh dropped the in-memory connection state and forced the user to reconnect
 * and re-attest. This stores the last verified connection (backend URL + the signed
 * attestation document + the PCRs read from it) so a refresh can restore it.
 *
 * SECURITY: what is cached is only the SIGNED document bytes and the URL — never a "verified"
 * verdict. On restore the browser RE-VERIFIES the cached document locally (COSE signature +
 * chain to the pinned AWS Nitro root) before trusting it, and the entry is discarded once the
 * leaf certificate's notAfter has passed. So a stale or tampered cache cannot pass as verified;
 * the cache only saves the round-trip, not the trust decision. Freshness beyond the initial
 * nonce challenge is bounded by the cert expiry (a cached session cannot outlive the leaf cert).
 */
import type { AttestationDocument, UserRole } from '../types'

const KEY_PREFIX = 'boltz.attestationSession'

function storageKey(role: UserRole): string {
  return `${KEY_PREFIX}.${role}`
}

export interface CachedAttestationSession {
  /** Backend URL the document was fetched from. */
  url: string
  /** The full attestation document as returned by the backend (includes raw_attestation). */
  attestation: AttestationDocument
  /** Leaf-certificate notAfter (ISO); the session is invalid once this passes. */
  certExpiry: string | null
  /** When this session was cached (ISO), for display/debugging. */
  savedAt: string
}

/** Persist the last verified connection for a role. */
export function saveAttestationSession(role: UserRole, session: CachedAttestationSession): void {
  try {
    localStorage.setItem(storageKey(role), JSON.stringify(session))
  } catch (e) {
    console.warn('Failed to cache attestation session:', e)
  }
}

/**
 * Read the cached session for a role, or null. Returns null (and clears the entry) once the
 * leaf certificate has expired, so an expired session never even reaches re-verification.
 */
export function getAttestationSession(role: UserRole): CachedAttestationSession | null {
  try {
    const raw = localStorage.getItem(storageKey(role))
    if (!raw) return null
    const session = JSON.parse(raw) as CachedAttestationSession
    if (session.certExpiry && new Date(session.certExpiry).getTime() <= Date.now()) {
      clearAttestationSession(role)
      return null
    }
    return session
  } catch (e) {
    console.warn('Failed to read cached attestation session:', e)
    return null
  }
}

/** Forget the cached session for a role (e.g. on disconnect or a failed re-verification). */
export function clearAttestationSession(role: UserRole): void {
  try {
    localStorage.removeItem(storageKey(role))
  } catch {
    /* ignore */
  }
}
