import { getDb } from '../db'
import { localDay } from '../../shared/generation-stats'

/**
 * Anlas 잔액 스냅샷 로그.
 * 사용량 = 기간 내 연속 스냅샷 간 "감소분"의 합 (충전/구매로 늘어난 구간은 무시).
 */

export function logBalance(balance: number): void {
  const db = getDb()
  const last = db.prepare('SELECT balance FROM anlas_log ORDER BY id DESC LIMIT 1').get() as
    { balance: number } | undefined
  if (last?.balance === balance) return // 변화 없으면 기록 생략
  db.prepare('INSERT INTO anlas_log (balance) VALUES (?)').run(balance)
}

function usageSince(sinceIsoUtc: string): number {
  const rows = getDb()
    .prepare(
      // 기간 직전 마지막 스냅샷 1개를 포함해야 기간 경계의 감소분을 놓치지 않는다
      `SELECT balance FROM anlas_log
       WHERE id >= COALESCE((SELECT MAX(id) FROM anlas_log WHERE created_at < ?), 0)
       ORDER BY id`
    )
    .all(sinceIsoUtc) as { balance: number }[]
  let used = 0
  for (let i = 1; i < rows.length; i++) {
    const drop = rows[i - 1].balance - rows[i].balance
    if (drop > 0) used += drop
  }
  return used
}

function utcIso(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

/** anlas_log의 created_at(UTC 'YYYY-MM-DD HH:MM:SS') → Date */
function parseUtc(text: string): Date {
  return new Date(`${text.replace(' ', 'T')}Z`)
}

/** sinceDay(로컬 YYYY-MM-DD)부터 로컬 날짜별 소모량. 감소분은 뒤쪽 스냅샷 시각의 날짜로 귀속 */
export function anlasDailyUsage(sinceDay: string): { day: string; spent: number }[] {
  const [y, m, d] = sinceDay.split('-').map(Number)
  const since = utcIso(new Date(y, m - 1, d))
  const rows = getDb()
    .prepare(
      `SELECT balance, created_at FROM anlas_log
       WHERE id >= COALESCE((SELECT MAX(id) FROM anlas_log WHERE created_at < ?), 0)
       ORDER BY id`
    )
    .all(since) as { balance: number; created_at: string }[]
  const byDay = new Map<string, number>()
  for (let i = 1; i < rows.length; i++) {
    const drop = rows[i - 1].balance - rows[i].balance
    if (drop <= 0 || rows[i].created_at < since) continue
    const day = localDay(parseUtc(rows[i].created_at))
    byDay.set(day, (byDay.get(day) ?? 0) + drop)
  }
  return [...byDay].map(([day, spent]) => ({ day, spent }))
}

export function anlasUsage(): { today: number; week: number } {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000)
  return {
    today: usageSince(utcIso(startOfToday)),
    week: usageSince(utcIso(weekAgo))
  }
}
