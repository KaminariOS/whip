import { getLocales } from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { en } from './locales/en';
import { zhHant } from './locales/zh-Hant';

type LocalePreference = Pick<ReturnType<typeof getLocales>[number], 'languageCode' | 'languageScriptCode' | 'regionCode'>;

export function languageForLocale(locale: LocalePreference | undefined): 'en' | 'zh-Hant' {
  if (!locale) return 'en';
  const traditionalRegion = locale.regionCode === 'TW' || locale.regionCode === 'HK' || locale.regionCode === 'MO';
  return locale.languageCode === 'zh' && (locale.languageScriptCode === 'Hant' || traditionalRegion)
    ? 'zh-Hant'
    : 'en';
}

export function deviceLanguage(): 'en' | 'zh-Hant' {
  return languageForLocale(getLocales()[0]);
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    'zh-Hant': { translation: zhHant },
  },
  lng: deviceLanguage(),
  fallbackLng: 'en',
  supportedLngs: ['en', 'zh-Hant'],
  keySeparator: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
}).catch(() => undefined);

export default i18n;
