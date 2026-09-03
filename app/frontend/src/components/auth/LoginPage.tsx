import { useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Authenticator } from '@aws-amplify/ui-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from './AuthProvider'
import { useTheme } from '../../contexts/ThemeContext'

export function LoginPage() {
  const { isAuthenticated } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()
  const { theme, toggleTheme } = useTheme()

  // Get the intended destination, default to home
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname || '/'

  useEffect(() => {
    if (isAuthenticated) {
      navigate(from, { replace: true })
    }
  }, [isAuthenticated, navigate, from])

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex flex-col items-center justify-center p-4">
      {/* Theme Toggle — the login screen renders before any dashboard, so it needs its
          own toggle; without it the theme can only be changed after signing in. */}
      <button
        onClick={toggleTheme}
        className="fixed top-4 right-4 p-2 rounded-lg bg-white/70 dark:bg-gray-800/70 hover:bg-white dark:hover:bg-gray-700 shadow-sm transition-colors"
        title={theme === 'light'
          ? t('roles.selector.switchToDark', { defaultValue: 'Switch to dark mode' })
          : t('roles.selector.switchToLight', { defaultValue: 'Switch to light mode' })}
        aria-label={theme === 'light'
          ? t('roles.selector.switchToDark', { defaultValue: 'Switch to dark mode' })
          : t('roles.selector.switchToLight', { defaultValue: 'Switch to light mode' })}
      >
        {theme === 'light' ? (
          <svg className="w-5 h-5 text-gray-600 dark:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
          </svg>
        ) : (
          <svg className="w-5 h-5 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
        )}
      </button>

      {/* Header */}
      <div className="text-center mb-8">
        <div className="flex items-center justify-center gap-3 mb-4">
          <svg className="w-10 h-10 text-primary-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">{t('auth.login.title')}</h1>
        </div>
        <p className="text-gray-600 dark:text-gray-400 max-w-md">
          {t('auth.login.subtitle')}
        </p>
      </div>

      {/* Authenticator */}
      <div className="w-full max-w-md">
        <Authenticator
          signUpAttributes={['email']}
          loginMechanisms={['email']}
          components={{
            Header() {
              // This renders INSIDE the Amplify Authenticator card, which keeps its own
              // (light) background regardless of our Tailwind `dark` class. So use fixed
              // dark-on-light text here; a `dark:` variant would turn white-on-white and
              // vanish in dark mode.
              return (
                <div className="text-center py-4">
                  <h2 className="text-xl font-semibold text-gray-800">{t('auth.login.welcomeHeading')}</h2>
                  <p className="text-sm text-gray-500">{t('auth.login.welcomeSubtitle')}</p>
                </div>
              )
            },
          }}
        >
          {({ user }) => (
            // Also inside the Authenticator card: fixed dark-on-light text (no dark: variant).
            <div className="text-center p-6">
              <p className="text-gray-600">{t('auth.login.signedInAs', { loginId: user?.signInDetails?.loginId })}</p>
              <p className="text-sm text-gray-500 mt-2">{t('auth.login.redirecting')}</p>
            </div>
          )}
        </Authenticator>
      </div>

      {/* Footer */}
      <div className="mt-8 text-center text-sm text-gray-500 dark:text-gray-400">
        <p>{t('auth.login.securedBy')}</p>
        <p className="mt-1">{t('auth.login.dataProtected')}</p>
      </div>
    </div>
  )
}