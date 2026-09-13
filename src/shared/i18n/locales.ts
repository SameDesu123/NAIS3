import { KO, type MessageCatalog } from './catalog-ko'
import { EN } from './catalog-en'
import { ZH_CN } from './catalog-zh-CN'

interface LocaleDefinition {
  /** Native-language name shown in the language picker. */
  label: string
  catalog: MessageCatalog
  fontFallback: string
  matches: (locale: Intl.Locale) => boolean
}

/** Register each supported language once; UI, locale detection and validation use this registry. */
export const LANGUAGES = {
  ko: {
    label: '한국어',
    catalog: KO,
    fontFallback: '',
    matches: (locale) => locale.language === 'ko'
  },
  en: {
    label: 'English',
    catalog: EN,
    fontFallback: '',
    matches: (locale) => locale.language === 'en'
  },
  'zh-CN': {
    label: '简体中文',
    catalog: ZH_CN,
    fontFallback:
      "'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', 'Source Han Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei'",
    matches: (locale) => locale.language === 'zh' && locale.maximize().script === 'Hans'
  }
} satisfies Record<string, LocaleDefinition>

export type Lang = keyof typeof LANGUAGES
export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGES) as Lang[]

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LANGUAGES, value)
}

/** Only used for fresh installs; stored language choices always take precedence. */
export function localeToLang(value: string): Lang {
  try {
    const locale = new Intl.Locale(value.replace(/_/g, '-'))
    return SUPPORTED_LANGUAGES.find((lang) => LANGUAGES[lang].matches(locale)) ?? 'en'
  } catch {
    return 'en'
  }
}
