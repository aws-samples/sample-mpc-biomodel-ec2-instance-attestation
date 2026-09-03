import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, NavLink, Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { useRole } from '../../contexts/RoleContext'
import { useTheme } from '../../contexts/ThemeContext'
import { useConnection } from '../../contexts/ConnectionContext'
import { ConnectionStatusCard } from '../common/ConnectionStatusCard'
import { listEncryptedSequences } from '../../services/s3'
import { apiRequest, getBackendUrl } from '../../services/api'
import type { PredictionJob } from '../../types'

export function BiologistDashboard() {
  const { user, signOutUser } = useAuth()
  const { roleConfig, clearRole } = useRole()
  const { theme, toggleTheme } = useTheme()
  const location = useLocation()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [showUserMenu, setShowUserMenu] = useState(false)

  const navItems = [
    { path: '/biologist', label: t('roles.biologist.navDashboard'), icon: '📊', exact: true },
    { path: '/biologist/connect', label: t('roles.biologist.navConnect'), icon: '🔗' },
    { path: '/biologist/kms', label: t('roles.biologist.navKms'), icon: '🔑' },
    { path: '/biologist/sequences', label: t('roles.biologist.navSequences'), icon: '🧬' },
    { path: '/biologist/jobs', label: t('roles.biologist.navJobs'), icon: '📈' },
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
                <span className="text-2xl">🧬</span>
                <span className="text-xl font-bold text-gray-900 dark:text-gray-100">{t('roles.biologist.brandName')}</span>
              </div>
              <div className="bg-blue-100 dark:bg-blue-800 text-blue-800 dark:text-blue-200 px-3 py-1 rounded-full text-sm font-medium">
                {roleConfig?.icon} {roleConfig?.name}
              </div>
            </div>

            {/* Theme Toggle + User Menu */}
            <div className="flex items-center gap-2">
              {/* Theme Toggle */}
              <button
                onClick={toggleTheme}
                className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                title={theme === 'light' ? t('roles.biologist.switchToDark') : t('roles.biologist.switchToLight')}
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
                <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center text-white text-sm font-medium">
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
                        {theme === 'light' ? '🌙' : '☀️'} {theme === 'light' ? t('roles.biologist.darkMode') : t('roles.biologist.lightMode')}
                      </button>
                      <button
                        onClick={() => {
                          clearRole()
                          setShowUserMenu(false)
                          navigate('/')
                        }}
                        className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        {t('roles.biologist.switchRole')}
                      </button>
                      <button
                        onClick={() => {
                          signOutUser()
                          setShowUserMenu(false)
                        }}
                        className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-300 hover:bg-red-50"
                      >
                        {t('roles.biologist.signOut')}
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
                      ? 'border-blue-500 text-blue-600 dark:text-blue-300' 
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
export function BiologistHome() {
  const { t } = useTranslation()
  const { state } = useConnection()
  const { user } = useAuth()
  const connected = state.isConnected && state.isVerified
  const base = '/biologist'

  // Live quick-stat counts.
  const [storedCount, setStoredCount] = useState<number | null>(null)
  const [activeJobs, setActiveJobs] = useState<number | null>(null)
  const [completedJobs, setCompletedJobs] = useState<number | null>(null)

  // Stored sequences: list S3 by user.sub (same identifier used at upload time).
  const loadStoredCount = useCallback(async () => {
    if (!user?.sub) return
    try {
      const items = await listEncryptedSequences('biologist', user.sub)
      setStoredCount(items.length)
    } catch (e) {
      console.warn('Could not count stored sequences:', e)
    }
  }, [user?.sub])

  // Job counts: only when a backend is connected (needs the API).
  const loadJobCounts = useCallback(async () => {
    if (!getBackendUrl()) return
    try {
      const jobs = await apiRequest<PredictionJob[]>('/api/v1/jobs?limit=200')
      setActiveJobs(jobs.filter(j => j.status === 'pending' || j.status === 'processing').length)
      setCompletedJobs(jobs.filter(j => j.status === 'completed').length)
    } catch (e) {
      console.warn('Could not load job counts:', e)
    }
  }, [])

  useEffect(() => {
    loadStoredCount()
  }, [loadStoredCount])

  useEffect(() => {
    loadJobCounts()
  }, [loadJobCounts, connected])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('roles.biologist.pageTitle')}</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">
          {t('roles.biologist.pageSubtitle')}
        </p>
      </div>

      {/* Live backend/attestation status */}
      <ConnectionStatusCard base={base} />

      {/* Workflow Overview — step 1 reflects live connection state */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('roles.biologist.workflowHeading')}</h2>
        <div className="grid md:grid-cols-5 gap-4">
          <WorkflowStep
            number={1}
            title={t('roles.biologist.step1Title')}
            description={t('roles.biologist.step1Desc')}
            icon="🔗"
            status={connected ? 'complete' : 'active'}
            to={`${base}/connect`}
          />
          <WorkflowStep
            number={2}
            title={t('roles.biologist.step2Title')}
            description={t('roles.biologist.step2Desc')}
            icon="🔑"
            status={connected ? 'active' : 'pending'}
            to={`${base}/kms`}
          />
          <WorkflowStep
            number={3}
            title={t('roles.biologist.step3Title')}
            description={t('roles.biologist.step3Desc')}
            icon="🧬"
            status="pending"
            to={`${base}/sequences`}
          />
          <WorkflowStep
            number={4}
            title={t('roles.biologist.step4Title')}
            description={t('roles.biologist.step4Desc')}
            icon="🔐"
            status="pending"
            to={`${base}/sequences`}
          />
          <WorkflowStep
            number={5}
            title={t('roles.biologist.step5Title')}
            description={t('roles.biologist.step5Desc')}
            icon="📥"
            status="pending"
            to={`${base}/jobs`}
          />
        </div>
      </div>

      {/* Quick Stats — live counts */}
      <div className="grid md:grid-cols-3 gap-6">
        <Link to={`${base}/sequences`} className="card hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('roles.biologist.statStoredSequences')}</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{storedCount ?? '—'}</p>
            </div>
            <div className="w-12 h-12 bg-blue-100 dark:bg-blue-800 rounded-lg flex items-center justify-center">
              <span className="text-2xl">🧬</span>
            </div>
          </div>
        </Link>

        <Link to={`${base}/jobs`} className="card hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('roles.biologist.statActiveJobs')}</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {connected ? (activeJobs ?? '—') : '—'}
              </p>
            </div>
            <div className="w-12 h-12 bg-yellow-100 dark:bg-yellow-800 rounded-lg flex items-center justify-center">
              <span className="text-2xl">⏳</span>
            </div>
          </div>
        </Link>

        <Link to={`${base}/jobs`} className="card hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('roles.biologist.statCompletedPredictions')}</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {connected ? (completedJobs ?? '—') : '—'}
              </p>
            </div>
            <div className="w-12 h-12 bg-green-100 dark:bg-green-800 rounded-lg flex items-center justify-center">
              <span className="text-2xl">✅</span>
            </div>
          </div>
        </Link>
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
        status === 'active' ? 'bg-blue-50 dark:bg-blue-900 border-blue-200 dark:border-blue-800' :
        'bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-700'}
    `}>
      <div className={`
        absolute -top-3 left-4 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold
        ${status === 'complete' ? 'bg-green-500 text-white' :
          status === 'active' ? 'bg-blue-500 text-white' :
          'bg-gray-300 dark:bg-gray-600 text-gray-600 dark:text-gray-300'}
      `}>
        {status === 'complete' ? '✓' : number}
      </div>
      <div className="mt-2">
        <span className="text-2xl">{icon}</span>
        <h4 className="font-medium text-gray-900 dark:text-gray-100 mt-2">{title}</h4>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{description}</p>
        {status === 'complete' && (
          <p className="text-xs text-green-600 dark:text-green-300 mt-1 font-medium">{t('roles.biologist.stepDone')}</p>
        )}
      </div>
    </div>
  )
  return to ? <Link to={to} className="block h-full">{body}</Link> : body
}