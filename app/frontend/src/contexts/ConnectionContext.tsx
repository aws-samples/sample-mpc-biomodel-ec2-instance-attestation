import { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react'
import type { AttestationDocument, TrustStoreEntry, AttestationInspection } from '../types'
import { normalizePcrValues, getVerifiedPcrs } from '../types'
import { useRole } from './RoleContext'
import { inspectAttestationDocument } from '../services/attestationVerifier'
import { getAttestationSession, clearAttestationSession } from '../services/attestationSession'
import { getTrustStore } from '../services/trustStore'

export interface ConnectionState {
  url: string
  isConnecting: boolean
  isConnected: boolean
  isVerified: boolean
  attestation: AttestationDocument | null
  /** The BROWSER's own verification verdict (COSE + chain-to-Nitro-root + nonce). This, not
   *  any backend-asserted flag, is what determines whether the connection is verified. */
  inspection: AttestationInspection | null
  error: string | null
  trustStore: TrustStoreEntry | null
  pcrComparison: Record<string, { value: string; expected: string | null; match: boolean }> | null
}

interface ConnectionContextType {
  state: ConnectionState
  setState: React.Dispatch<React.SetStateAction<ConnectionState>>
}

const ConnectionContext = createContext<ConnectionContextType | undefined>(undefined)

interface ConnectionProviderProps {
  children: ReactNode
}

/**
 * Holds the backend-connection + attestation state at the app level so it survives
 * route navigation. BackendConnection is a route element, so switching tabs (e.g. to
 * Prediction Jobs) unmounts it and would otherwise discard the verified attestation.
 * Lifting the state here keeps the connection live across tab switches; only the URL
 * is still mirrored to localStorage (for cross-session recall) inside the component.
 */
const initialState = (): ConnectionState => ({
  url: localStorage.getItem('backendUrl') || '',
  isConnecting: false,
  isConnected: false,
  isVerified: false,
  attestation: null,
  inspection: null,
  error: null,
  trustStore: null,
  pcrComparison: null,
})

export function ConnectionProvider({ children }: ConnectionProviderProps) {
  const { role } = useRole()
  const [state, setState] = useState<ConnectionState>(initialState)

  // The trust store is per-role, but this connection state is app-level. Without a
  // reset, switching roles (e.g. biophysicist -> biologist) would carry over the
  // previous role's verified attestation + PCR comparison, so the new role would see
  // a stale green "verified" state over its own (possibly empty) baseline. Reset the
  // attestation/verification state whenever the active role changes so each role
  // re-attests against its own trust store. The URL is preserved (it is a convenience,
  // and re-verification against the new role's baseline still runs).
  const prevRole = useRef(role)
  useEffect(() => {
    if (prevRole.current !== role) {
      prevRole.current = role
      setState(prev => ({
        ...initialState(),
        url: prev.url,
      }))
    }
  }, [role])

  // Restore a cached attestation session on mount / role change, so a page refresh does not
  // force a reconnect while the leaf cert is still valid (~3h). The cached document is
  // RE-VERIFIED locally here (COSE signature + chain to the pinned AWS Nitro root) before it
  // is trusted — the cache saves the round-trip, never the trust decision. Declared AFTER the
  // reset effect so on a role switch the reset runs first, then this restores that role's own
  // session. No network call is made.
  useEffect(() => {
    if (!role) return
    let cancelled = false
    ;(async () => {
      const cached = getAttestationSession(role)
      if (!cached || !cached.attestation?.raw_attestation) return
      try {
        const inspection = await inspectAttestationDocument(cached.attestation.raw_attestation)
        if (cancelled) return
        if (!inspection.verified) {
          clearAttestationSession(role)
          return
        }
        const verifiedPcrs = normalizePcrValues(getVerifiedPcrs(inspection) || {})
        const attestation = { ...cached.attestation, pcr_values: verifiedPcrs }
        const trustStore = getTrustStore(role, 'prod')
        if (trustStore) trustStore.pcr_values = normalizePcrValues(trustStore.pcr_values)
        const pcrComparison: ConnectionState['pcrComparison'] = {}
        for (const [pcr, value] of Object.entries(verifiedPcrs)) {
          const expected = trustStore?.pcr_values?.[pcr] ?? null
          pcrComparison[pcr] = { value, expected, match: expected === null || expected === value }
        }
        const comparedPcrs = Object.values(pcrComparison).filter((p) => p.expected !== null)
        const trustMatched = !!trustStore && comparedPcrs.length > 0 && comparedPcrs.every((p) => p.match)
        if (cancelled) return
        setState((prev) => ({
          ...prev,
          url: cached.url || prev.url,
          isConnecting: false,
          isConnected: true,
          isVerified: inspection.verified === true && trustMatched,
          attestation,
          inspection,
          trustStore: trustStore ?? null,
          pcrComparison,
          error: null,
        }))
      } catch {
        clearAttestationSession(role)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [role])

  return (
    <ConnectionContext.Provider value={{ state, setState }}>
      {children}
    </ConnectionContext.Provider>
  )
}

export function useConnection() {
  const context = useContext(ConnectionContext)
  if (context === undefined) {
    throw new Error('useConnection must be used within a ConnectionProvider')
  }
  return context
}
