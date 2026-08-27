/**
 * 한국어 원문을 키로 쓰는 최소 i18n 레이어.
 * - ko: 키(원문)를 그대로 사용
 * - en: dict-en의 매핑을 사용, 없으면 원문 폴백
 * 파라미터는 {0}, {1} 위치 플레이스홀더로 치환한다.
 */
export type Lang = 'ko' | 'en'

export function isLang(value: unknown): value is Lang {
  return value === 'ko' || value === 'en'
}

/**
 * {0}, {1}, ... 플레이스홀더를 args로 치환.
 * 영어 복수형은 {0|image|images} 형태로 args[0]이 1인지에 따라 고른다.
 * (한국어는 복수형이 없어 키에 이 문법이 등장하지 않는다 — 한국어 모드는 무영향)
 */
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

export function translate(
  dict: Record<string, string>,
  lang: Lang,
  key: string,
  args: readonly (string | number)[]
): string {
  return format(lang === 'en' ? (dict[key] ?? key) : key, args)
}
