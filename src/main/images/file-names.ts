/**
 * 출력 파일 이름 — 씬 이름·외부 파일 이름처럼 사용자가 정한 글자를 파일 이름으로 쓸 때.
 * 이름은 배타적으로 만든다(쓰기는 'wx'): 여기선 후보만 고르고, 이미 있으면 다음 _N으로 넘어간다.
 * electron·fs에 의존하지 않는다
 */

/** 확장자와 _N을 붙여도 255바이트 안에 들도록 넉넉히 */
export const MAX_STEM_BYTES = 150

// Windows 장치 이름 — 확장자가 붙어도(CON.png) 예약이다. 위 첨자 숫자도 예약
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g
const ILLEGAL = /[/\\:*?"<>|]/g

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0
  let out = ''
  // 코드 포인트 단위로 자른다 — 서로게이트 쌍을 가르지 않게
  for (const ch of text) {
    bytes += Buffer.byteLength(ch, 'utf8')
    if (bytes > maxBytes) break
    out += ch
  }
  return out
}

/**
 * 파일 이름 앞부분(확장자 제외)으로 쓸 수 있게 다듬는다. 금지 문자는 '_', 제어 문자는 뺀다.
 * 앞의 점(숨김 파일)은 '_', 끝의 점·공백(Windows가 지운다)은 뺀다. 길이는 UTF-8 바이트로 자른다.
 * Windows 예약 이름이면 앞에 '_'. 남는 게 없으면 fallback
 */
export function safeFileStem(name: string, fallback: string): string {
  let stem = name.replace(CONTROL, '').replace(ILLEGAL, '_').trim()
  stem = stem.replace(/^\.+/, (dots) => '_'.repeat(dots.length))
  stem = truncateUtf8(stem, MAX_STEM_BYTES).replace(/[. ]+$/, '')
  if (!stem) return fallback
  if (RESERVED.test(stem.split('.')[0].trimEnd())) stem = `_${stem}`
  return stem
}

/**
 * n번째 후보 이름. firstPlain이면 1번은 번호 없이(기존 이름 폴더·메인 출력), 아니면 _1부터
 * (UUID 씬 폴더 — 씬 이름_1, _2 ...)
 */
export function numberedName(stem: string, n: number, ext: string, firstPlain: boolean): string {
  return n === 1 && firstPlain ? `${stem}.${ext}` : `${stem}_${n}.${ext}`
}

/**
 * 폴더에 이미 있는 이름으로 첫 후보 번호를 고른다 — 가장 큰 번호 다음. 확장자는 가리지 않는다
 * (포맷을 바꿔도 번호가 이어지게). 배타 쓰기가 최종 판정이다
 */
export function nextNumber(existing: Iterable<string>, stem: string, firstPlain: boolean): number {
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const plain = new RegExp(`^${escaped}\\.[^.]+$`, 'i')
  const numbered = new RegExp(`^${escaped}_(\\d+)\\.[^.]+$`, 'i')
  let max = 0
  for (const name of existing) {
    if (firstPlain && plain.test(name)) max = Math.max(max, 1)
    const match = numbered.exec(name)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max + 1
}
