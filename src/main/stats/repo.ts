import { getDb } from '../db'
import { anlasDailyUsage } from '../nai/anlas-log'
import {
  generationCategory,
  localDay,
  type GenerationStats,
  type GenerationStatsRow
} from '../../shared/generation-stats'

/** 생성 1건 기록. 통계 실패가 생성 흐름을 깨면 안 되므로 예외는 삼킨다 */
export function recordGeneration(kind: string, date: Date = new Date()): void {
  if (!generationCategory(kind)) return
  try {
    getDb()
      .prepare(
        `INSERT INTO generation_stats (day, kind, count) VALUES (?, ?, 1)
         ON CONFLICT (day, kind) DO UPDATE SET count = count + 1`
      )
      .run(localDay(date), kind)
  } catch (e) {
    console.warn('[stats] record failed', e)
  }
}

export function generationStats(): GenerationStats {
  const rows = getDb()
    .prepare('SELECT day, kind, count FROM generation_stats ORDER BY day')
    .all() as GenerationStatsRow[]
  const since = rows[0]?.day ?? null
  return { since, rows, anlas: since ? anlasDailyUsage(since) : [] }
}
