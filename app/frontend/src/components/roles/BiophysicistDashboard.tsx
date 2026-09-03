import { useState } from 'react'
import { Outlet, NavLink, Link, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthProvider'
import { useRole } from '../../contexts/RoleContext'
import { useTheme } from '../../contexts/ThemeContext'
import { useConnection } from '../../contexts/ConnectionContext'
import { ConnectionStatusCard } from '../common/ConnectionStatusCard'

export function BiophysicistDashboard() {
  const { t } = useTranslation()
  const { user, signOutUser } = useAuth()
  const { roleConfig, clearRole } = useRole()
  const { theme, toggleTheme } = useTheme()
  const location = useLocation()
  const navigate = useNavigate()
  const [showUserMenu, setShowUserMenu] = useState(false)

  const navItems = [
    { path: '/biophysicist', label: t('roles.biophysicist.navDashboard'), icon: '📊', exact: true },
    { path: '/biophysicist/connect', label: t('roles.biophysicist.navBackendConnection'), icon: '🔗' },
    { path: '/biophysicist/kms', label: t('roles.biophysicist.navKmsPolicy'), icon: '🔑' },
    { path: '/biophysicist/models', label: t('roles.biophysicist.navModelWeights'), icon: '⚛️' },
    { path: '/biophysicist/deployments', label: t('roles.biophysicist.navDeployments'), icon: '🚀' },
  ]

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            {/* Logo and Role Badge */}
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-2xl">⚛️</span>
                <span className="text-xl font-bold text-gray-900 dark:text-gray-100">{t('roles.biophysicist.brandName')}</span>
              </div>
              <div className="bg-purple-100 dark:bg-purple-800 text-purple-800 dark:text-purple-200 px-3 py-1 rounded-full text-sm font-medium">
                {roleConfig?.icon} {roleConfig?.name}
              </div>
            </div>

            {/* Theme Toggle + User Menu */}
            <div className="flex items-center gap-2">
              {/* Theme Toggle */}
              <button
                onClick={toggleTheme}
                className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                title={theme === 'light' ? t('roles.biophysicist.switchToDarkMode') : t('roles.biophysicist.switchToLightMode')}
              >
                {theme === 'light' ? (
                  <svg className="w-5 h-5 text-gray-600 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                  </svg>
                )}
              </button>

              {/* User Menu */}
              <div className="relative">
                <button
                  onClick={() => setShowUserMenu(!showUserMenu)}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <div className="w-8 h-8 bg-purple-500 rounded-full flex items-center justify-center text-white text-sm font-medium">
                    {user?.email?.charAt(0).toUpperCase()}
                  </div>
                  <span className="text-sm text-gray-700 dark:text-gray-300 hidden sm:block">{user?.email}</span>
                  <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {showUserMenu && (
                  <>
                    <div className="fixed inset-0" onClick={() => setShowUserMenu(false)} />
                    <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1">
                      <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-700">
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{user?.email}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">{roleConfig?.name}</p>
                      </div>
                      <button
                        onClick={() => {
                          toggleTheme()
                          setShowUserMenu(false)
                        }}
                        className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2"
                      >
                        {theme === 'light' ? '🌙' : '☀️'} {theme === 'light' ? t('roles.biophysicist.darkMode') : t('roles.biophysicist.lightMode')}
                      </button>
                      <button
                        onClick={() => {
                          clearRole()
                          setShowUserMenu(false)
                          navigate('/')
                        }}
                        className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        {t('roles.biophysicist.switchRole')}
                      </button>
                      <button
                        onClick={() => {
                          signOutUser()
                          setShowUserMenu(false)
                        }}
                        className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-300 hover:bg-red-50"
                      >
                        {t('roles.biophysicist.signOut')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Navigation */}
      <nav className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex gap-1 overflow-x-auto">
            {navItems.map((item) => {
              const isActive = item.exact
                ? location.pathname === item.path
                : location.pathname.startsWith(item.path)

              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={`
                    flex items-center gap-2 px-4 py-3 text-sm font-medium whitespace-nowrap
                    border-b-2 transition-colors
                    ${isActive
                      ? 'border-purple-500 text-purple-600 dark:text-purple-300'
                      : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:border-gray-300'}
                  `}
                >
                  <span>{item.icon}</span>
                  <span>{item.label}</span>
                </NavLink>
              )
            })}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Outlet />
      </main>
    </div>
  )
}

// Default dashboard content
export function BiophysicistHome() {
  const { t } = useTranslation()
  const { state } = useConnection()
  const connected = state.isConnected && state.isVerified
  const base = '/biophysicist'

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('roles.biophysicist.homeTitle')}</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">
          {t('roles.biophysicist.homeSubtitle')}
        </p>
      </div>

      {/* Live backend/attestation status */}
      <ConnectionStatusCard base={base} />

      {/* Workflow Overview — step 1 reflects live connection state */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('roles.biophysicist.workflowHeading')}</h2>
        <div className="grid md:grid-cols-5 gap-4">
          <WorkflowStep
            number={1}
            title={t('roles.biophysicist.step1Title')}
            description={t('roles.biophysicist.step1Description')}
            icon="🔗"
            status={connected ? 'complete' : 'active'}
            to={`${base}/connect`}
          />
          <WorkflowStep
            number={2}
            title={t('roles.biophysicist.step2Title')}
            description={t('roles.biophysicist.step2Description')}
            icon="🔑"
            status={connected ? 'active' : 'pending'}
            to={`${base}/kms`}
          />
          <WorkflowStep
            number={3}
            title={t('roles.biophysicist.step3Title')}
            description={t('roles.biophysicist.step3Description')}
            icon="📦"
            status="pending"
            to={`${base}/models`}
          />
          <WorkflowStep
            number={4}
            title={t('roles.biophysicist.step4Title')}
            description={t('roles.biophysicist.step4Description')}
            icon="🔐"
            status="pending"
            to={`${base}/models`}
          />
          <WorkflowStep
            number={5}
            title={t('roles.biophysicist.step5Title')}
            description={t('roles.biophysicist.step5Description')}
            icon="🚀"
            status="pending"
            to={`${base}/deployments`}
          />
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid md:grid-cols-3 gap-6">
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('roles.biophysicist.statModelVersions')}</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">0</p>
            </div>
            <div className="w-12 h-12 bg-purple-100 dark:bg-purple-800 rounded-lg flex items-center justify-center">
              <span className="text-2xl">📦</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('roles.biophysicist.statActiveDeployments')}</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">0</p>
            </div>
            <div className="w-12 h-12 bg-yellow-100 dark:bg-yellow-800 rounded-lg flex items-center justify-center">
              <span className="text-2xl">🚀</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('roles.biophysicist.statCurrentActiveModel')}</p>
              <p className="text-lg font-bold text-gray-900 dark:text-gray-100">{t('roles.biophysicist.statCurrentActiveModelNone')}</p>
            </div>
            <div className="w-12 h-12 bg-green-100 dark:bg-green-800 rounded-lg flex items-center justify-center">
              <span className="text-2xl">✅</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function WorkflowStep({
  number,
  title,
  description,
  icon,
  status,
  to,
}: {
  number: number
  title: string
  description: string
  icon: string
  status: 'pending' | 'active' | 'complete'
  to?: string
}) {
  const { t } = useTranslation()
  const body = (
    <div className={`
      relative p-4 rounded-lg border h-full transition-shadow
      ${to ? 'hover:shadow-md' : ''}
      ${status === 'complete' ? 'bg-green-50 dark:bg-green-900 border-green-200 dark:border-green-800' :
        status === 'active' ? 'bg-purple-50 dark:bg-purple-900 border-purple-200 dark:border-purple-800' :
        'bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-700'}
    `}>
      <div className={`
        absolute -top-3 left-4 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold
        ${status === 'complete' ? 'bg-green-500 text-white' :
          status === 'active' ? 'bg-purple-500 text-white' :
          'bg-gray-300 dark:bg-gray-600 text-gray-600 dark:text-gray-300'}
      `}>
        {status === 'complete' ? '✓' : number}
      </div>
      <div className="mt-2">
        <span className="text-2xl">{icon}</span>
        <h4 className="font-medium text-gray-900 dark:text-gray-100 mt-2">{title}</h4>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{description}</p>
        {status === 'complete' && (
          <p className="text-xs text-green-600 dark:text-green-300 mt-1 font-medium">{t('roles.biophysicist.stepDone')}</p>
        )}
      </div>
    </div>
  )
  return to ? <Link to={to} className="block h-full">{body}</Link> : body
}
