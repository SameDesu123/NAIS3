/**
 * 프롬프트 에디터 자동완성 — 키 처리 결정과 커서 유효성 판단 (순수 함수, DOM 무관).
 *
 * 선택 모델:
 * - 목록이 처음 뜨면 아무것도 선택하지 않는다(selected = -1). 첫 항목은 "Tab 기본값"일 뿐
 * - ↑/↓로 고른 항목만 Enter로 삽입 — 그 외 Enter는 평소대로 줄바꿈(목록은 닫힘)
 * - Tab은 고른 항목, 없으면 첫 항목
 */

export type SuggestionKind = 'frag' | 'tag'

/** 태그 토큰 경계 — 이 글자가 토큰 안에 끼면 다른 토큰 */
export const TAG_TOKEN_SEPARATORS = /[,\n{}[\]|<>:/]/
/** 조각 토큰 경계 — refreshSuggestions의 `<([^<>|]*)$`와 같은 집합 */
export const FRAG_TOKEN_SEPARATORS = /[<>|]/

export const NO_SELECTION = -1

export type AutocompleteKeyAction =
  /** 자동완성이 관여하지 않음 — 기본 동작 그대로 */
  | { type: 'ignore' }
  /** 항목 선택만 바꿈 (preventDefault) */
  | { type: 'select'; index: number }
  /** index 항목 삽입 (preventDefault) */
  | { type: 'complete'; index: number }
  /** 목록만 닫고 기본 동작은 그대로 (Enter → 줄바꿈, Mod+Enter → 생성 단축키) */
  | { type: 'close' }
  /** 목록 닫기 (preventDefault + stopPropagation — 바깥 Escape 핸들러에 안 넘김) */
  | { type: 'dismiss' }

export interface AutocompleteKeyInput {
  key: string
  /** 표시 중인 추천 수 */
  count: number
  /** 현재 선택 (NO_SELECTION = 미선택) */
  selected: number
  /** IME 조합 중 (isComposing 또는 keyCode 229) */
  composing: boolean
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

export function autocompleteKeyAction(input: AutocompleteKeyInput): AutocompleteKeyAction {
  const { key, count, selected, composing } = input
  // 한글 조합 중 Enter/방향키는 IME 확정·후보 이동용 — 가로채면 글자가 깨지거나 엉뚱한 삽입
  if (composing || count === 0) return { type: 'ignore' }
  const hasSelection = selected >= 0 && selected < count
  const modified = !!(input.ctrlKey || input.metaKey || input.altKey)

  switch (key) {
    case 'ArrowDown':
      if (modified) return { type: 'ignore' }
      return { type: 'select', index: hasSelection ? (selected + 1) % count : 0 }
    case 'ArrowUp':
      if (modified) return { type: 'ignore' }
      return { type: 'select', index: hasSelection ? (selected - 1 + count) % count : count - 1 }
    case 'Tab':
      // Shift+Tab은 포커스 이동 관례 그대로
      if (input.shiftKey || modified) return { type: 'ignore' }
      return { type: 'complete', index: hasSelection ? selected : 0 }
    case 'Enter':
      // 직접 고른 항목이 있을 때만 삽입. 태그를 다 치고 줄을 바꾸려던 Enter를 먹지 않는다
      if (hasSelection && !modified && !input.shiftKey) {
        return { type: 'complete', index: selected }
      }
      return { type: 'close' }
    case 'Escape':
      return { type: 'dismiss' }
    default:
      return { type: 'ignore' }
  }
}

/**
 * 현재 선택이 자동완성 대상 토큰 "안"에 있는지.
 * 클릭·방향키·Home/End·드래그로 커서가 토큰을 벗어났다면 false — 이때 삽입하면
 * value.slice(0, tokenStart) + insert + value.slice(cursor)가 글을 지우거나 중복시킨다.
 */
export function isCaretInToken(
  text: string,
  tokenStart: number,
  selectionStart: number,
  selectionEnd: number,
  kind: SuggestionKind
): boolean {
  if (tokenStart < 0) return false
  if (selectionStart !== selectionEnd) return false // 범위 선택
  const cursor = selectionStart
  if (cursor < tokenStart || cursor > text.length) return false
  const separators = kind === 'frag' ? FRAG_TOKEN_SEPARATORS : TAG_TOKEN_SEPARATORS
  return !separators.test(text.slice(tokenStart, cursor))
}
