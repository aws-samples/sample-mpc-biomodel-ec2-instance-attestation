import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import type { UserRole, RoleConfig } from '../types'
import { ROLE_CONFIGS } from '../types'

interface RoleContextType {
  role: UserRole | null
  roleConfig: RoleConfig | null
  setRole: (role: UserRole) => void
  clearRole: () => void
  isRoleSelected: boolean
}

const RoleContext = createContext<RoleContextType | undefined>(undefined)

const ROLE_STORAGE_KEY = 'boltz-user-role'

interface RoleProviderProps {
  children: ReactNode
}

export function RoleProvider({ children }: RoleProviderProps) {
  const [role, setRoleState] = useState<UserRole | null>(() => {
    // Initialize from localStorage
    const stored = localStorage.getItem(ROLE_STORAGE_KEY)
    if (stored && (stored === 'biologist' || stored === 'biophysicist')) {
      return stored as UserRole
    }
    return null
  })

  const setRole = (newRole: UserRole) => {
    setRoleState(newRole)
    localStorage.setItem(ROLE_STORAGE_KEY, newRole)
  }

  const clearRole = () => {
    setRoleState(null)
    localStorage.removeItem(ROLE_STORAGE_KEY)
  }

  // Sync with localStorage changes (for multi-tab support)
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === ROLE_STORAGE_KEY) {
        if (e.newValue && (e.newValue === 'biologist' || e.newValue === 'biophysicist')) {
          setRoleState(e.newValue as UserRole)
        } else {
          setRoleState(null)
        }
      }
    }

    window.addEventListener('storage', handleStorageChange)
    return () => window.removeEventListener('storage', handleStorageChange)
  }, [])

  const roleConfig = role ? ROLE_CONFIGS[role] : null

  return (
    <RoleContext.Provider
      value={{
        role,
        roleConfig,
        setRole,
        clearRole,
        isRoleSelected: role !== null,
      }}
    >
      {children}
    </RoleContext.Provider>
  )
}

export function useRole() {
  const context = useContext(RoleContext)
  if (context === undefined) {
    throw new Error('useRole must be used within a RoleProvider')
  }
  return context
}