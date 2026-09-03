import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { getCurrentUser, signOut, fetchAuthSession } from 'aws-amplify/auth'
import { Hub } from 'aws-amplify/utils'
import type { User, AuthState } from '../../types'

interface AuthContextType extends AuthState {
  signOutUser: () => Promise<void>
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

interface AuthProviderProps {
  children: ReactNode
}

export function AuthProvider({ children }: AuthProviderProps) {
  const { t } = useTranslation()
  const [authState, setAuthState] = useState<AuthState>({
    isAuthenticated: false,
    isLoading: true,
    user: null,
    error: null,
  })

  const checkUser = async () => {
    try {
      const currentUser = await getCurrentUser()
      await fetchAuthSession()
      
      const user: User = {
        username: currentUser.username,
        email: currentUser.signInDetails?.loginId || '',
        emailVerified: true, // Cognito verifies email during signup
        sub: currentUser.userId,
      }

      setAuthState({
        isAuthenticated: true,
        isLoading: false,
        user,
        error: null,
      })
    } catch (error) {
      // User is not authenticated
      setAuthState({
        isAuthenticated: false,
        isLoading: false,
        user: null,
        error: null,
      })
    }
  }

  const signOutUser = async () => {
    try {
      await signOut()
      setAuthState({
        isAuthenticated: false,
        isLoading: false,
        user: null,
        error: null,
      })
    } catch (error) {
      console.error('Error signing out:', error)
      setAuthState(prev => ({
        ...prev,
        error: t('auth.provider.signOutError'),
      }))
    }
  }

  const refreshUser = async () => {
    setAuthState(prev => ({ ...prev, isLoading: true }))
    await checkUser()
  }

  useEffect(() => {
    checkUser()

    // Listen for auth events
    const hubListener = Hub.listen('auth', ({ payload }) => {
      switch (payload.event) {
        case 'signedIn':
          checkUser()
          break
        case 'signedOut':
          setAuthState({
            isAuthenticated: false,
            isLoading: false,
            user: null,
            error: null,
          })
          break
        case 'tokenRefresh':
          checkUser()
          break
        case 'tokenRefresh_failure':
          setAuthState(prev => ({
            ...prev,
            error: t('auth.provider.sessionExpired'),
          }))
          break
      }
    })

    return () => hubListener()
  }, [])

  return (
    <AuthContext.Provider
      value={{
        ...authState,
        signOutUser,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}