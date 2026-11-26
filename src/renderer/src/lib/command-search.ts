/**
 * 커맨드 바 검색 — 라벨에 검색어가 얼마나 잘 맞는지 점수를 매긴다.
 *
 * - 공백은 무시한다 ("씬모드"도 "씬 모드"에 맞는다)
 * - 한글 초성으로 찾을 수 있다 ("ㅆㅁ" → "씬 모드", "씬ㅁ"처럼 섞어도 된다)
 * - 조합 중인 마지막 글자는 받침 없이도 맞는다 ("새" → "생성"). IME가 글자를 다 짜기 전에도
 *   결과가 깜빡이지 않게 하려는 것이다
 * - 이어진 일치가 흩어진 일치보다, 앞쪽·단어 첫머리 일치가 중간 일치보다 위에 온다
 */

const CHOSEONG = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'
const SYLLABLE_FIRST = 0xac00
const SYLLABLE_LAST = 0xd7a3
/** 중성 21 × 종성 28 — 초성 하나가 차지하는 음절 수 */
const PER_INITIAL = 588
const PER_MEDIAL = 28

function syllableIndex(c: string): number | null {
  const code = c.charCodeAt(0)
  return code >= SYLLABLE_FIRST && code <= SYLLABLE_LAST ? code - SYLLABLE_FIRST : null
}

function charMatches(target: string, query: string, last: boolean): boolean {
  if (target === query) return true
  const t = syllableIndex(target)
  if (t === null) return false
  if (CHOSEONG.includes(query)) return CHOSEONG[Math.floor(t / PER_INITIAL)] === query
  if (!last) return false
  const q = syllableIndex(query)
  // 받침 없는 글자는 아직 받침을 붙이는 중일 수 있다 — 초성·중성만 같으면 맞는 것으로 본다
  return q !== null && q % PER_MEDIAL === 0 && Math.floor(t / PER_MEDIAL) === q / PER_MEDIAL
}

const SPACE = /\s/u
const WORD_CHAR = /[\p{L}\p{N}]/u

function normalize(text: string): string {
  return text.normalize('NFC').toLowerCase()
}

/** 0보다 큰 점수면 맞는 것이다. 안 맞으면 null, 검색어가 비었으면 0 */
export function scoreMatch(text: string, query: string): number | null {
  const q = [...normalize(query)].filter((c) => !SPACE.test(c))
  if (q.length === 0) return 0

  const chars: string[] = []
  const wordStart: boolean[] = []
  let boundary = true
  for (const c of normalize(text)) {
    if (SPACE.test(c)) {
      boundary = true
      continue
    }
    chars.push(c)
    wordStart.push(boundary)
    boundary = !WORD_CHAR.test(c)
  }

  let best: number | null = null
  for (let i = 0; i + q.length <= chars.length; i++) {
    if (!q.every((c, j) => charMatches(chars[i + j], c, j === q.length - 1))) continue
    const score = i === 0 ? 100 : wordStart[i] ? 80 : 60
    if (best === null || score > best) best = score
    if (score === 100) break
  }
  if (best !== null) return best

  // 흩어진 일치 — 글자 사이가 벌어질수록 낮게 친다
  let j = 0
  let gaps = 0
  let started = false
  for (let i = 0; i < chars.length && j < q.length; i++) {
    if (charMatches(chars[i], q[j], j === q.length - 1)) {
      j++
      started = true
    } else if (started) {
      gaps++
    }
  }
  return j === q.length ? Math.max(1, 40 - gaps) : null
}

export interface RankedMatch<T> {
  item: T
  /** 가장 잘 맞은 텍스트의 위치 (textsOf가 준 배열 기준). 검색어가 비었으면 null */
  textIndex: number | null
}

/**
 * 검색어에 맞는 항목만 점수 순으로 돌려준다. 같은 점수끼리는 원래 순서를 지킨다.
 * 항목마다 여러 텍스트(지금 언어 라벨, 다른 언어 라벨 등)를 받아 가장 잘 맞는 것으로 친다.
 * 점수가 같으면 앞의 텍스트를 고른다 — 지금 언어 라벨을 맨 앞에 주면 그쪽이 우선이다.
 */
export function rankMatches<T>(
  items: readonly T[],
  query: string,
  textsOf: (item: T) => string[]
): RankedMatch<T>[] {
  if (query.trim() === '') return items.map((item) => ({ item, textIndex: null }))
  const scored: { item: T; score: number; index: number; textIndex: number }[] = []
  items.forEach((item, index) => {
    const texts = textsOf(item)
    let best: number | null = null
    let textIndex = 0
    for (let i = 0; i < texts.length; i++) {
      const score = scoreMatch(texts[i], query)
      if (score !== null && (best === null || score > best)) {
        best = score
        textIndex = i
      }
    }
    if (best !== null) scored.push({ item, score: best, index, textIndex })
  })
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.map(({ item, textIndex }) => ({ item, textIndex }))
}
