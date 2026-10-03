import { describe, expect, it } from 'vitest'
import {
  bumpGenerationStats,
  generationCategory,
  localDay,
  niceTicks,
  shiftDay,
  summarizeGenerationStats,
  type GenerationStatsRow
} from '../src/shared/generation-stats'

describe('생성 통계', () => {
  it('저장 kind를 일반/씬/디렉터로 분류하고 로컬 편집 결과는 제외한다', () => {
    expect(['t2i', 'i2i', 'inpaint'].map(generationCategory)).toEqual([
      'general',
      'general',
      'general'
    ])
    expect(generationCategory('scene')).toBe('scene')
    expect(generationCategory('upscale')).toBe('director')
    expect(generationCategory('bg-removal')).toBe('director')
    expect(generationCategory('declutter-keep-bubbles')).toBe('director')
    expect(generationCategory('mosaic')).toBeNull()
    expect(generationCategory('generated')).toBeNull()
  })

  it('날짜는 UTC가 아닌 로컬 기준으로 자른다', () => {
    expect(localDay(new Date(2026, 0, 2, 0, 30))).toBe('2026-01-02')
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('같은 날짜×종류는 한 행으로 누적하고 제외 대상은 기록하지 않는다', () => {
    const rows: GenerationStatsRow[] = []
    const at = new Date(2026, 9, 3, 12)
    bumpGenerationStats(rows, 't2i', at)
    bumpGenerationStats(rows, 't2i', at)
    bumpGenerationStats(rows, 'scene', at)
    bumpGenerationStats(rows, 'mosaic', at)
    expect(rows).toEqual([
      { day: '2026-10-03', kind: 't2i', count: 2 },
      { day: '2026-10-03', kind: 'scene', count: 1 }
    ])
  })

  it('기간 요약은 빈 날을 0으로 채우되 집계 시작일 이전은 그리지 않는다', () => {
    const summary = summarizeGenerationStats(
      {
        since: '2026-10-01',
        rows: [
          { day: '2026-10-01', kind: 't2i', count: 3 },
          { day: '2026-10-01', kind: 'lineart', count: 1 },
          { day: '2026-10-03', kind: 'scene', count: 5 },
          { day: '2026-10-03', kind: 'i2i', count: 2 }
        ],
        anlas: [
          { day: '2026-10-01', spent: 40 },
          { day: '2026-10-03', spent: 60 }
        ]
      },
      7,
      '2026-10-03'
    )
    expect(summary.days.map((d) => d.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
    expect(summary.days[1]).toMatchObject({ general: 0, scene: 0, director: 0, total: 0 })
    expect(summary.days[2]).toMatchObject({
      general: 2,
      scene: 5,
      director: 0,
      total: 7,
      anlas: 60
    })
    expect(summary.period).toEqual({ general: 5, scene: 5, director: 1, total: 11, anlas: 100 })
    expect(summary.today).toBe(7)
    expect(summary.allTime).toBe(11)
    expect(summary.kinds[0]).toEqual({ kind: 'scene', category: 'scene', count: 5 })
  })

  it('기간 밖 기록은 누적에만 들어간다', () => {
    const summary = summarizeGenerationStats(
      {
        since: '2026-09-01',
        rows: [
          { day: '2026-09-01', kind: 't2i', count: 10 },
          { day: '2026-10-03', kind: 't2i', count: 1 }
        ],
        anlas: [{ day: '2026-09-01', spent: 99 }]
      },
      7,
      '2026-10-03'
    )
    expect(summary.days).toHaveLength(7)
    expect(summary.period.total).toBe(1)
    expect(summary.period.anlas).toBe(0)
    expect(summary.allTime).toBe(11)
  })

  it('축 눈금은 최대값을 덮는 깔끔한 단위로 나눈다', () => {
    expect(niceTicks(0)).toEqual([0, 1])
    expect(niceTicks(3)).toEqual([0, 1, 2, 3])
    expect(niceTicks(37)).toEqual([0, 10, 20, 30, 40])
    expect(niceTicks(180)).toEqual([0, 50, 100, 150, 200])
  })
})
