import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import en from './locales/en.json'

// Keys are flat string literals in the form MODULE.FEATURE.name (e.g.
// 'ec2agent.agent-status.title'). The '.' is part of the key, not a nesting
// separator, so keySeparator/nsSeparator are disabled. escapeValue is off
// because React already escapes interpolated values.
i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
  },
  lng: 'en',
  fallbackLng: 'en',
  keySeparator: false,
  nsSeparator: false,
  interpolation: {
    escapeValue: false,
  },
})

export default i18n
