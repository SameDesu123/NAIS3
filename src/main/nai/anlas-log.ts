import { getDb } from '../db'

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

export function anlasUsage(): { today: number; week: number } {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000)
  return {
    today: usageSince(utcIso(startOfToday)),
    week: usageSince(utcIso(weekAgo))
  }
}
