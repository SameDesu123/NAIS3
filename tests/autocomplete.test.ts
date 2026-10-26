import { describe, expect, it } from 'vitest'
import {
  autocompleteKeyAction,
  isCaretInToken,
  NO_SELECTION,
  type AutocompleteKeyInput
} from '../src/renderer/src/lib/autocomplete'

function key(
  k: string,
  selected = NO_SELECTION,
  extra: Partial<AutocompleteKeyInput> = {}
): ReturnType<typeof autocompleteKeyAction> {
  return autocompleteKeyAction({ key: k, count: 5, selected, composing: false, ...extra })
}

describe('자동완성 키 처리', () => {
  it('미선택 상태의 Enter는 줄바꿈 (목록만 닫고 기본 동작 유지)', () => {
    expect(key('Enter')).toEqual({ type: 'close' })
  })

  it('화살표로 선택한 뒤의 Enter는 그 항목 삽입', () => {
    const down = key('ArrowDown')
    expect(down).toEqual({ type: 'select', index: 0 })
    expect(key('ArrowDown', 0)).toEqual({ type: 'select', index: 1 })
    expect(key('Enter', 1)).toEqual({ type: 'complete', index: 1 })
  })

  it('미선택 상태의 ↑는 마지막 항목, 끝에서는 순환', () => {
    expect(key('ArrowUp')).toEqual({ type: 'select', index: 4 })
    expect(key('ArrowUp', 0)).toEqual({ type: 'select', index: 4 })
    expect(key('ArrowDown', 4)).toEqual({ type: 'select', index: 0 })
  })

  it('Tab의 기본값은 첫 항목, 선택이 있으면 선택 항목', () => {
    expect(key('Tab')).toEqual({ type: 'complete', index: 0 })
    expect(key('Tab', 3)).toEqual({ type: 'complete', index: 3 })
  })

  it('Shift+Tab은 포커스 이동 관례 그대로', () => {
    expect(key('Tab', NO_SELECTION, { shiftKey: true })).toEqual({ type: 'ignore' })
  })

  it('Mod+Enter(생성 단축키)·Shift+Enter는 선택이 있어도 삽입하지 않는다', () => {
    expect(key('Enter', 2, { ctrlKey: true })).toEqual({ type: 'close' })
    expect(key('Enter', 2, { metaKey: true })).toEqual({ type: 'close' })
    expect(key('Enter', 2, { shiftKey: true })).toEqual({ type: 'close' })
  })

  it('Escape는 목록 닫기', () => {
    expect(key('Escape')).toEqual({ type: 'dismiss' })
  })

  it('IME 조합 중에는 모든 키를 무시', () => {
    for (const k of ['Enter', 'Tab', 'ArrowDown', 'ArrowUp', 'Escape']) {
      expect(key(k, 1, { composing: true })).toEqual({ type: 'ignore' })
    }
  })

  it('목록이 비어 있으면 무시', () => {
    expect(
      autocompleteKeyAction({ key: 'Enter', count: 0, selected: 0, composing: false })
    ).toEqual({ type: 'ignore' })
  })

  it('범위를 벗어난 selected는 미선택으로 취급', () => {
    expect(key('Enter', 7)).toEqual({ type: 'close' })
    expect(key('Tab', 7)).toEqual({ type: 'complete', index: 0 })
  })

  it('그 외 키는 관여하지 않음', () => {
    expect(key('a', 1)).toEqual({ type: 'ignore' })
    expect(key('ArrowLeft', 1)).toEqual({ type: 'ignore' })
  })
})

describe('커서 유효성 (토큰 안에 있는지)', () => {
  // "1girl, blue h" — 토큰 "blue h"는 7부터
  const text = '1girl, blue h'
  const start = 7

  it('토큰 끝/중간에 접힌 커서는 유효', () => {
    expect(isCaretInToken(text, start, 13, 13, 'tag')).toBe(true)
    expect(isCaretInToken(text, start, 9, 9, 'tag')).toBe(true)
    expect(isCaretInToken(text, start, start, start, 'tag')).toBe(true)
  })

  it('커서가 토큰 앞으로 이동하면 무효', () => {
    expect(isCaretInToken(text, start, 6, 6, 'tag')).toBe(false)
    expect(isCaretInToken(text, start, 0, 0, 'tag')).toBe(false)
  })

  it('커서가 구분자를 넘어 뒤로 이동하면 무효', () => {
    const more = '1girl, blue h, smile'
    expect(isCaretInToken(more, start, 20, 20, 'tag')).toBe(false)
    expect(isCaretInToken('blue h\nsmile', 0, 9, 9, 'tag')).toBe(false)
  })

  it('텍스트 길이를 넘는 커서는 무효', () => {
    expect(isCaretInToken(text, start, 99, 99, 'tag')).toBe(false)
  })

  it('범위 선택은 무효', () => {
    expect(isCaretInToken(text, start, 8, 13, 'tag')).toBe(false)
  })

  it('토큰 시작이 없으면 무효', () => {
    expect(isCaretInToken(text, -1, 13, 13, 'tag')).toBe(false)
  })

  it('조각 토큰은 <>| 가 경계 — 태그 구분자(,·:)는 넘어도 유효', () => {
    // "<sty" — 토큰은 1부터
    expect(isCaretInToken('<sty', 1, 4, 4, 'frag')).toBe(true)
    expect(isCaretInToken('<a/b:c', 1, 6, 6, 'frag')).toBe(true)
    expect(isCaretInToken('<sty>, x', 1, 8, 8, 'frag')).toBe(false)
    expect(isCaretInToken('<sty', 1, 0, 0, 'frag')).toBe(false)
  })
})
