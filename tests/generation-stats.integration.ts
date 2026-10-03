import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb } from '../src/main/db'
import { generationStats, recordGeneration } from '../src/main/stats/repo'

const environment = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => environment.directory, getLocale: () => 'ko' },
  safeStorage: { isEncryptionAvailable: () => false }
}))

/** 로컬 시각 → anlas_log와 같은 UTC 'YYYY-MM-DD HH:MM:SS' */
function utc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

beforeEach(() => {
  environment.directory = mkdtempSync(join(tmpdir(), 'nais3-stats-'))
  initDb()
})

afterEach(() => {
  closeDb()
  rmSync(environment.directory, { recursive: true, force: true })
})

describe('generation_stats', () => {
  it('새 DB는 빈 통계로 시작한다 (소급 없음)', () => {
    expect(generationStats()).toEqual({ since: null, rows: [], anlas: [] })
  })

  it('날짜×종류별로 누적하고 로컬 편집 결과는 세지 않는다', () => {
    const day1 = new Date(2026, 9, 1, 23, 50)
    const day2 = new Date(2026, 9, 2, 0, 10)
    recordGeneration('t2i', day1)
    recordGeneration('t2i', day1)
    recordGeneration('scene', day2)
    recordGeneration('bg-removal', day2)
    recordGeneration('mosaic', day2)
    const stats = generationStats()
    expect(stats.since).toBe('2026-10-01')
    expect(stats.rows).toEqual(
      expect.arrayContaining([
        { day: '2026-10-01', kind: 't2i', count: 2 },
        { day: '2026-10-02', kind: 'scene', count: 1 },
        { day: '2026-10-02', kind: 'bg-removal', count: 1 }
      ])
    )
    expect(stats.rows).toHaveLength(3)
  })

  it('Anlas 소모는 집계 시작일부터 로컬 날짜별 감소분만 합산한다', () => {
    const insert = getDb().prepare('INSERT INTO anlas_log (balance, created_at) VALUES (?, ?)')
    insert.run(1000, utc(new Date(2026, 8, 30, 12))) // 시작일 이전 기준점
    insert.run(900, utc(new Date(2026, 8, 30, 13))) // 시작일 이전 소모 — 제외
    insert.run(880, utc(new Date(2026, 9, 1, 9)))
    insert.run(5000, utc(new Date(2026, 9, 1, 10))) // 충전 — 무시
    insert.run(4950, utc(new Date(2026, 9, 2, 0, 5)))
    recordGeneration('t2i', new Date(2026, 9, 1, 9))
    expect(generationStats().anlas).toEqual([
      { day: '2026-10-01', spent: 20 },
      { day: '2026-10-02', spent: 50 }
    ])
  })
})
