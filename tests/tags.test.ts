import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock-app' }
}))

vi.mock('fs', () => ({
  readFileSync: vi.fn(() =>
    JSON.stringify([
      { value: 'very long hair', count: 1_000, type: 'general' },
      { value: 'long sleeves', count: 500, type: 'general' },
      { value: 'long hair', count: 400, type: 'general' },
      { value: 'blonde hair', count: 300, type: 'general' },
      { value: 'longshot', count: 200, type: 'artist' }
    ])
  )
}))

import { searchTags } from '../src/main/tags'

describe('태그 자동완성', () => {
  it('두 글자 미만의 검색어에는 결과를 반환하지 않는다', () => {
    expect(searchTags('l')).toEqual([])
    expect(searchTags(' _ ')).toEqual([])
  })

  it('대소문자와 밑줄을 정규화해 검색한다', () => {
    expect(searchTags(' LONG_HAIR ').map((tag) => tag.tag)).toEqual(['long hair', 'very long hair'])
  })

  it('더 인기 있는 부분 일치보다 접두어 일치를 먼저 반환한다', () => {
    expect(searchTags('long').map((tag) => tag.tag)).toEqual([
      'long sleeves',
      'long hair',
      'longshot',
      'very long hair'
    ])
  })

  it('요청한 결과 개수를 넘기지 않는다', () => {
    expect(searchTags('long', 2).map((tag) => tag.tag)).toEqual(['long sleeves', 'long hair'])
  })
})
