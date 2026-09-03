import { useTranslation } from 'react-i18next'
import { ROLE_CONFIGS } from '../../types'
import type { UserRole } from '../../types'
import { useRole } from '../../contexts/RoleContext'
import { useTheme } from '../../contexts/ThemeContext'

export function RoleSelector() {
  const { t } = useTranslation()
  const { setRole } = useRole()
  const { theme, toggleTheme } = useTheme()

  const handleSelectRole = (role: UserRole) => {
    setRole(role)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex flex-col items-center justify-center p-4">
      {/* Theme Toggle — the role-select screen renders before any dashboard, so it needs
          its own toggle; otherwise the theme can only be changed after picking a role. */}
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
      <div className="text-center mb-12">
        <div className="flex items-center justify-center gap-3 mb-4">
          <svg className="w-12 h-12 text-primary-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
          <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-100">{t('roles.selector.title')}</h1>
        </div>
        <p className="text-xl text-gray-600 dark:text-gray-400 max-w-2xl">
          {t('roles.selector.subtitle')}
        </p>
      </div>

      {/* Role Selection */}
      <div className="w-full max-w-4xl">
        <h2 className="text-2xl font-semibold text-center text-gray-800 dark:text-gray-200 mb-8">
          {t('roles.selector.selectYourRole')}
        </h2>

        <div className="grid md:grid-cols-2 gap-6">
          {Object.values(ROLE_CONFIGS).map((config) => (
            <button
              key={config.id}
              onClick={() => handleSelectRole(config.id)}
              className={`
                group relative p-8 bg-white dark:bg-gray-800 rounded-2xl shadow-lg border-2 border-transparent
                hover:border-${config.primaryColor}-500 hover:shadow-xl
                transition-all duration-200 text-left
                focus:outline-none focus:ring-4 focus:ring-${config.primaryColor}-200
              `}
            >
              {/* Icon */}
              <div className={`
                w-16 h-16 rounded-xl bg-${config.primaryColor}-100 dark:bg-${config.primaryColor}-900
                flex items-center justify-center text-4xl mb-4
                group-hover:scale-110 transition-transform duration-200
              `}>
                {config.icon}
              </div>

              {/* Title */}
              <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">
                {config.name}
              </h3>

              {/* Description */}
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                {config.description}
              </p>

              {/* Features */}
              <div className="space-y-2">
                {config.id === 'biologist' ? (
                  <>
                    <Feature icon="🔐" text={t('roles.selector.biologistFeatureEncrypt')} />
                    <Feature icon="✅" text={t('roles.selector.biologistFeatureVerify')} />
                    <Feature icon="📊" text={t('roles.selector.biologistFeatureRun')} />
                    <Feature icon="📥" text={t('roles.selector.biologistFeatureDownload')} />
                  </>
                ) : (
                  <>
                    <Feature icon="📦" text={t('roles.selector.biophysicistFeatureUpload')} />
                    <Feature icon="✅" text={t('roles.selector.biophysicistFeatureVerify')} />
                    <Feature icon="🚀" text={t('roles.selector.biophysicistFeatureDeploy')} />
                    <Feature icon="📋" text={t('roles.selector.biophysicistFeatureManage')} />
                  </>
                )}
              </div>

              {/* Select Arrow */}
              <div className={`
                absolute top-8 right-8 w-10 h-10 rounded-full
                bg-${config.primaryColor}-100 dark:bg-${config.primaryColor}-900 text-${config.primaryColor}-600 dark:text-${config.primaryColor}-300
                flex items-center justify-center
                opacity-0 group-hover:opacity-100 transition-opacity
              `}>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="mt-12 text-center text-sm text-gray-500 dark:text-gray-400">
        <p>{t('roles.selector.footerEncrypted')}</p>
        <p className="mt-1">{t('roles.selector.footerDecryption')}</p>
      </div>
    </div>
  )
}

function Feature({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
      <span>{icon}</span>
      <span>{text}</span>
    </div>
  )
}
