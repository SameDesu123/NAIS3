import { describe, expect, it } from 'vitest'
import {
  format,
  isLang,
  localeToLang,
  translate,
  LANGUAGES,
  SUPPORTED_LANGUAGES,
  type Lang,
  type MessageCatalog,
  type MessageId
} from '../src/shared/i18n'
import { KO } from '../src/shared/i18n/catalog-ko'

const slots = (text: string): string[] =>
  [...new Set([...text.matchAll(/\{(\d+)[|}]/g)].map((match) => match[1]))].sort()

describe('i18n catalogs', () => {
  for (const lang of SUPPORTED_LANGUAGES) {
    it(`${lang}: has every stable ID, nonempty messages and matching placeholders`, () => {
      const catalog = LANGUAGES[lang].catalog
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(KO).sort())
      for (const id of Object.keys(KO) as MessageId[]) {
        expect(id).toMatch(/^[a-z][a-z0-9]*(\.[A-Za-z0-9]+)+$/)
        expect(catalog[id].trim(), `${lang}: ${id} is empty`).not.toBe('')
        expect(slots(catalog[id]), `${lang}: ${id} has mismatched placeholders`).toEqual(
          slots(KO[id])
        )
        // Reject malformed numeric placeholders rather than displaying them to users.
        const rest = catalog[id].replace(/\{\d+(?:\|[^|{}]*\|[^|{}]*)?\}/g, '')
        expect(rest, `${lang}: ${id} has malformed placeholder syntax`).not.toMatch(/\{\d/)
      }
    })
  }

  it('translates stable IDs independently of the display language', () => {
    expect(translate('ko', 'ui.settings', [])).toBe('설정')
    expect(translate('en', 'ui.settings', [])).toBe('Settings')
    expect(translate('zh-CN', 'ui.settings', [])).toBe('设置')
    expect(translate('ko', 'ui.valueImages', [3])).toBe('3장')
    expect(translate('zh-CN', 'ui.valueImages', [3])).toBe('3 张')
  })

  it('does not translate or recursively interpolate user-provided values', () => {
    expect(translate('en', 'ui.copyValue', ['설정 {0} ui.settings'])).toBe(
      'Copy 설정 {0} ui.settings'
    )
  })

  it('falls back safely when a runtime language or message is unavailable', () => {
    expect(translate('unsupported' as Lang, 'ui.settings', [])).toBe('Settings')
    expect(translate('__proto__' as Lang, 'ui.settings', [])).toBe('Settings')
    expect(translate('en', 'missing.id' as MessageId, [])).toBe('missing.id')
    const catalog: Partial<MessageCatalog> = LANGUAGES['zh-CN'].catalog
    const saved = catalog['ui.settings']
    try {
      delete catalog['ui.settings']
      expect(translate('zh-CN', 'ui.settings', [])).toBe('Settings')
    } finally {
      catalog['ui.settings'] = saved
    }
  })

  it('keeps existing positional and English singular/plural formatting', () => {
    expect(format('{0} {0|image|images}', [1])).toBe('1 image')
    expect(format('{0} {0|image|images}', [2])).toBe('2 images')
    expect(format('{0} {0|image|images}', [0])).toBe('0 images')
    expect(format('{0}: {1} {1|image|images}', ['Scene', 1])).toBe('Scene: 1 image')
    expect(format('{0}: {1} {1|image|images}', ['Scene', 5])).toBe('Scene: 5 images')
    expect(format('{0} {0|image|images}', ['1'])).toBe('1 image')
    expect(format('{0} {0|image|images}', ['1,234'])).toBe('1,234 images')
    expect(format('{0} {0|image|images}', [])).toBe('{0} {0|image|images}')
  })

  it('accepts only registered language codes', () => {
    for (const lang of SUPPORTED_LANGUAGES) expect(isLang(lang)).toBe(true)
    for (const value of ['zh', 'zh-TW', 'jp', null, '__proto__', 'constructor'])
      expect(isLang(value)).toBe(false)
  })

  it.each([
    ['ko', 'ko'],
    ['ko-KR', 'ko'],
    ['zh-CN', 'zh-CN'],
    ['zh-Hans', 'zh-CN'],
    ['zh-Hans-CN', 'zh-CN'],
    ['zh_CN', 'zh-CN'],
    ['zh-SG', 'zh-CN'],
    ['zh', 'zh-CN'],
    ['zh-TW', 'en'],
    ['zh-HK', 'en'],
    ['zh-MO', 'en'],
    ['zh-Hant', 'en'],
    ['zh-Hant-TW', 'en'],
    ['zh-Hant-CN', 'en'],
    ['zh-Hans-TW', 'zh-CN'],
    ['en-US', 'en'],
    ['ja', 'en'],
    ['', 'en'],
    ['invalid locale', 'en']
  ])('maps fresh-install locale %s to %s', (locale, expected) => {
    expect(localeToLang(locale)).toBe(expected)
  })
})
