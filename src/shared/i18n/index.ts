import { EN } from './catalog-en'
import { KO, type MessageId } from './catalog-ko'
import { isLang, LANGUAGES, type Lang } from './locales'

export type { MessageCatalog, MessageId } from './catalog-ko'
export { LANGUAGES, SUPPORTED_LANGUAGES, isLang, localeToLang, type Lang } from './locales'

/** Positional arguments and the existing two-form plural syntax used by the English catalog. */
export function format(template: string, args: readonly (string | number)[]): string {
  if (args.length === 0) return template
  return template
    .replace(/\{(\d+)\|([^|{}]*)\|([^|{}]*)\}/g, (match, index, one, many) => {
      const value = args[Number(index)]
      return value === undefined ? match : Number(value) === 1 ? one : many
    })
    .replace(/\{(\d+)\}/g, (match, index) => {
      const value = args[Number(index)]
      return value === undefined ? match : String(value)
    })
}

export function translate(lang: Lang, id: MessageId, args: readonly (string | number)[]): string {
  // Catalog completeness is checked before merge; a stale runtime must still render usable text.
  const translated = isLang(lang) ? LANGUAGES[lang].catalog[id] : undefined
  return format(translated ?? EN[id] ?? KO[id] ?? id, args)
}
