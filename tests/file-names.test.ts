import { describe, expect, it } from 'vitest'
import {
  MAX_STEM_BYTES,
  nextNumber,
  numberedName,
  safeFileStem
} from '../src/main/images/file-names'

describe('safeFileStem', () => {
  it('replaces characters Windows forbids and drops control characters', () => {
    expect(safeFileStem('a/b\\c:d*e?f"g<h>i|j', 'x')).toBe('a_b_c_d_e_f_g_h_i_j')
    expect(safeFileStem('tab\there\u0000\u007f', 'x')).toBe('tabhere')
  })

  it('avoids hidden names and trailing dots or spaces', () => {
    expect(safeFileStem('..secret', 'x')).toBe('__secret')
    expect(safeFileStem('scene. . ', 'x')).toBe('scene')
    expect(safeFileStem('  spaced  ', 'x')).toBe('spaced')
  })

  it('prefixes Windows device names, with or without an extension-like suffix', () => {
    expect(safeFileStem('CON', 'x')).toBe('_CON')
    expect(safeFileStem('con.', 'x')).toBe('_con')
    expect(safeFileStem('nul.backup', 'x')).toBe('_nul.backup')
    expect(safeFileStem('COM¹', 'x')).toBe('_COM¹')
    expect(safeFileStem('conin$', 'x')).toBe('_conin$')
    expect(safeFileStem('console', 'x')).toBe('console')
    expect(safeFileStem('COM0', 'x')).toBe('COM0')
  })

  it('cuts long names by UTF-8 bytes without splitting a character', () => {
    const korean = safeFileStem('가'.repeat(100), 'x')
    expect(Buffer.byteLength(korean)).toBeLessThanOrEqual(MAX_STEM_BYTES)
    expect(korean).toBe('가'.repeat(50))
    const emoji = safeFileStem('a' + '😀'.repeat(60), 'x')
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(MAX_STEM_BYTES)
    expect(emoji.endsWith('\ud83d')).toBe(false)
  })

  it('falls back when nothing usable is left', () => {
    expect(safeFileStem('', 'fallback')).toBe('fallback')
    expect(safeFileStem(' \u0000 ', 'fallback')).toBe('fallback')
    // 점만 있는 이름은 숨김 파일이 되지 않게 '_'로 남는다
    expect(safeFileStem(' . . ', 'fallback')).toBe('_')
  })
})

describe('numbered names', () => {
  it('leaves the first name plain only when asked', () => {
    expect(numberedName('a', 1, 'png', true)).toBe('a.png')
    expect(numberedName('a', 2, 'png', true)).toBe('a_2.png')
    expect(numberedName('a', 1, 'png', false)).toBe('a_1.png')
  })

  it('continues after the highest number, ignoring case and extension', () => {
    expect(nextNumber([], 'a', false)).toBe(1)
    expect(nextNumber(['a_1.png', 'A_7.WEBP', 'a_3.png'], 'a', false)).toBe(8)
    expect(nextNumber(['a.png'], 'a', true)).toBe(2)
    expect(nextNumber(['a.png'], 'a', false)).toBe(1)
  })

  it('does not count other stems or regex look-alikes', () => {
    expect(nextNumber(['ab_9.png', 'a_x.png', 'a_2.png.tmp', 'a.b_5.png'], 'a', true)).toBe(1)
    expect(nextNumber(['a.b_5.png', 'axb_6.png'], 'a.b', false)).toBe(6)
  })
})
