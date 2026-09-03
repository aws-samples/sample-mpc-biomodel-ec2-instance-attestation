import { Link } from 'react-router-dom'
import { useTranslation, Trans } from 'react-i18next'
import { useAuth } from '../auth/AuthProvider'

export function Dashboard() {
  const { user } = useAuth()
  const { t } = useTranslation()
  const greetingSuffix = user?.email ? `, ${user.email.split('@')[0]}` : ''

  return (
    <div className="space-y-8">
      {/* Welcome Section */}
      <div className="card">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-primary-100 rounded-full flex items-center justify-center">
            <span className="text-2xl">👋</span>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              <Trans i18nKey="common.dashboard.welcomeBack" values={{ suffix: greetingSuffix }}>{/* nosemgrep: jsx-not-internationalized */}
                Welcome back{'{{suffix}}'}!
              </Trans>
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              {t('common.dashboard.tagline')}
            </p>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Connect Backend */}
        <Link to="/connect" className="card hover:shadow-md transition-shadow group">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-blue-100 dark:bg-blue-800 rounded-lg flex items-center justify-center group-hover:bg-blue-200 transition-colors">
              <span className="text-2xl">🔗</span>
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 group-hover:text-primary-600">
                {t('common.dashboard.connectBackendTitle')}
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {t('common.dashboard.connectBackendDesc')}
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center text-sm text-primary-600">
            <span>{t('common.dashboard.connectNow')}</span>
            <svg className="w-4 h-4 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </Link>

        {/* Manage Sequences */}
        <Link to="/sequences" className="card hover:shadow-md transition-shadow group">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-green-100 dark:bg-green-800 rounded-lg flex items-center justify-center group-hover:bg-green-200 transition-colors">
              <span className="text-2xl">🧬</span>
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 group-hover:text-primary-600">
                {t('common.dashboard.manageSequencesTitle')}
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {t('common.dashboard.manageSequencesDesc')}
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center text-sm text-primary-600">
            <span>{t('common.dashboard.manageSequencesAction')}</span>
            <svg className="w-4 h-4 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </Link>

        {/* View Predictions */}
        <Link to="/jobs" className="card hover:shadow-md transition-shadow group">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-purple-100 dark:bg-purple-800 rounded-lg flex items-center justify-center group-hover:bg-purple-200 transition-colors">
              <span className="text-2xl">🔬</span>
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 group-hover:text-primary-600">
                {t('common.dashboard.predictionsTitle')}
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {t('common.dashboard.predictionsDesc')}
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center text-sm text-primary-600">
            <span>{t('common.dashboard.viewPredictions')}</span>
            <svg className="w-4 h-4 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </Link>
      </div>

      {/* How It Works */}
      <div className="card">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-6">{t('common.dashboard.howItWorks')}</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="text-center">
            <div className="w-12 h-12 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <span className="text-xl font-bold text-primary-600">1</span>
            </div>
            <h3 className="font-medium text-gray-900 dark:text-gray-100">{t('common.dashboard.step1Title')}</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {t('common.dashboard.step1Desc')}
            </p>
          </div>
          <div className="text-center">
            <div className="w-12 h-12 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <span className="text-xl font-bold text-primary-600">2</span>
            </div>
            <h3 className="font-medium text-gray-900 dark:text-gray-100">{t('common.dashboard.step2Title')}</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {t('common.dashboard.step2Desc')}
            </p>
          </div>
          <div className="text-center">
            <div className="w-12 h-12 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <span className="text-xl font-bold text-primary-600">3</span>
            </div>
            <h3 className="font-medium text-gray-900 dark:text-gray-100">{t('common.dashboard.step3Title')}</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {t('common.dashboard.step3Desc')}
            </p>
          </div>
          <div className="text-center">
            <div className="w-12 h-12 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <span className="text-xl font-bold text-primary-600">4</span>
            </div>
            <h3 className="font-medium text-gray-900 dark:text-gray-100">{t('common.dashboard.step4Title')}</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {t('common.dashboard.step4Desc')}
            </p>
          </div>
        </div>
      </div>

      {/* Security Info */}
      <div className="card bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-200 dark:border-blue-800">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 bg-blue-100 dark:bg-blue-800 rounded-lg flex items-center justify-center flex-shrink-0">
            <span className="text-2xl">🔒</span>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('common.dashboard.securityTitle')}</h2>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              {t('common.dashboard.securityDesc')}
            </p>
            <div className="mt-4 flex flex-wrap gap-4">
              <div className="flex items-center gap-2 text-sm">
                <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                <span className="text-gray-600 dark:text-gray-400">{t('common.dashboard.featureCose')}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                <span className="text-gray-600 dark:text-gray-400">{t('common.dashboard.featureRootCa')}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                <span className="text-gray-600 dark:text-gray-400">{t('common.dashboard.featurePcr16')}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}