import { describe, expect, it } from 'vitest'
import { rankByQuery, scoreMatch } from '../src/renderer/src/lib/command-search'

describe('scoreMatch', () => {
  it('matches case-insensitively and ignores spaces', () => {
    expect(scoreMatch('Open settings', 'SETTINGS')).not.toBeNull()
    expect(scoreMatch('씬 모드', '씬모드')).not.toBeNull()
    expect(scoreMatch('씬모드', '씬 모드')).not.toBeNull()
  })

  it('matches Korean initial consonants, alone or mixed with syllables', () => {
    expect(scoreMatch('씬 모드', 'ㅆㅁ')).not.toBeNull()
    expect(scoreMatch('씬 모드', '씬ㅁ')).not.toBeNull()
    expect(scoreMatch('설정 열기', 'ㅅㅈ')).not.toBeNull()
    expect(scoreMatch('씬 모드', 'ㅅㅁ')).toBeNull()
  })

  it('lets the syllable still being composed match before its final consonant', () => {
    // IME가 "생"을 짜는 동안 입력창에는 "새"가 먼저 들어온다
    expect(scoreMatch('생성', '새')).not.toBeNull()
    expect(scoreMatch('생성', '생서')).not.toBeNull()
    // 조합이 끝난 앞 글자는 정확히 맞아야 한다
    expect(scoreMatch('생성', '새성')).toBeNull()
  })

  it('ranks prefix, word-start, middle and scattered matches in that order', () => {
    const prefix = scoreMatch('mode main', 'mo')!
    const wordStart = scoreMatch('main mode', 'mo')!
    const middle = scoreMatch('lemon', 'mo')!
    const scattered = scoreMatch('main door', 'md')!
    expect(prefix).toBeGreaterThan(wordStart)
    expect(wordStart).toBeGreaterThan(middle)
    expect(middle).toBeGreaterThan(scattered)
    expect(scattered).toBeGreaterThan(0)
  })

  it('returns null when the characters are not all present in order', () => {
    expect(scoreMatch('Open settings', 'xyz')).toBeNull()
    expect(scoreMatch('ab', 'ba')).toBeNull()
  })
})

describe('rankByQuery', () => {
  const items = ['Main mode', 'Scene mode', 'Open settings', 'Toggle prompt panel']

  it('keeps every item in order for an empty query', () => {
    expect(rankByQuery(items, '  ', (s) => [s])).toEqual(items)
  })

  it('drops non-matches and keeps the original order among equal scores', () => {
    expect(rankByQuery(items, 'mode', (s) => [s])).toEqual(['Main mode', 'Scene mode'])
  })

  it('puts better matches first', () => {
    // "prompt"의 첫머리가 "Open" 가운데보다 위
    expect(rankByQuery(items, 'p', (s) => [s])).toEqual(['Toggle prompt panel', 'Open settings'])
    expect(rankByQuery(items, 'se', (s) => [s])[0]).toBe('Open settings')
    expect(rankByQuery(items, 'sc', (s) => [s])[0]).toBe('Scene mode')
  })

  it('uses the best score among an item’s texts', () => {
    const labels: Record<string, string[]> = {
      settings: ['설정 열기', 'Open settings'],
      scene: ['씬 모드', 'Scene mode']
    }
    expect(rankByQuery(Object.keys(labels), 'settings', (k) => labels[k])).toEqual(['settings'])
    expect(rankByQuery(Object.keys(labels), 'ㅆ', (k) => labels[k])).toEqual(['scene'])
  })
})
