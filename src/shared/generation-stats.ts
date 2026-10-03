/**
 * 생성 통계 — 날짜(로컬)×종류별 생성 횟수.
 * 히스토리(images)와 분리된 누적 카운터라 이미지를 지워도 숫자는 남는다.
 * 집계는 이 기능이 들어간 업데이트 이후 생성분부터 (기존 히스토리 소급 없음).
 */

export type GenerationCategory = 'general' | 'scene' | 'director'

/** 표시 순서 = 색 슬롯 순서 (고정, 순위로 재배색하지 않음) */
export const GENERATION_CATEGORIES: readonly GenerationCategory[] = ['general', 'scene', 'director']

const GENERAL_KINDS = new Set(['t2i', 'i2i', 'inpaint'])
const DIRECTOR_KINDS = new Set([
  'upscale',
  'bg-removal',
  'lineart',
  'sketch',
  'colorize',
  'emotion',
  'declutter',
  'declutter-keep-bubbles'
])

/** 저장 kind → 통계 분류. NovelAI 호출이 아닌 로컬 결과(mosaic 등)는 null = 집계 제외 */
export function generationCategory(kind: string): GenerationCategory | null {
  if (GENERAL_KINDS.has(kind)) return 'general'
  if (kind === 'scene') return 'scene'
  if (DIRECTOR_KINDS.has(kind)) return 'director'
  return null
}

export interface GenerationStatsRow {
  /** 로컬 날짜 YYYY-MM-DD */
  day: string
  kind: string
  count: number
}

export interface GenerationStats {
  /** 첫 기록 날짜 (기록이 없으면 null) */
  since: string | null
  rows: GenerationStatsRow[]
  /** 날짜별 Anlas 소모 (since 이후만) */
  anlas: { day: string; spent: number }[]
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 로컬 시간 기준 YYYY-MM-DD — UTC로 자르면 한국 기준 자정~오전 9시가 전날로 밀린다 */
export function localDay(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** day에서 offset일 이동한 로컬 날짜 (DST에도 안전하게 날짜 단위로 계산) */
export function shiftDay(day: string, offset: number): string {
  const date = parseDay(day)
  date.setDate(date.getDate() + offset)
  return localDay(date)
}

/** rows에 day×kind 카운트를 +1 (브라우저 런타임용 — 데스크톱은 SQL upsert) */
export function bumpGenerationStats(
  rows: GenerationStatsRow[],
  kind: string,
  date: Date = new Date()
): void {
  if (!generationCategory(kind)) return
  const day = localDay(date)
  const row = rows.find((r) => r.day === day && r.kind === kind)
  if (row) row.count += 1
  else rows.push({ day, kind, count: 1 })
}

export type CategoryCounts = Record<GenerationCategory, number>

export interface StatsDay extends CategoryCounts {
  day: string
  total: number
  anlas: number
}

export interface StatsSummary {
  /** 기간 내 날짜 (오래된 → 최근, 기록 없는 날은 0으로 채움) */
  days: StatsDay[]
  /** 기간 합계 */
  period: CategoryCounts & { total: number; anlas: number }
  /** 기간 내 세부 kind별 합계 (많은 순) */
  kinds: { kind: string; category: GenerationCategory; count: number }[]
  today: number
  /** 집계 시작 이후 누적 */
  allTime: number
}

function emptyCounts(): CategoryCounts {
  return { general: 0, scene: 0, director: 0 }
}

/**
 * 최근 rangeDays일(오늘 포함) 요약. 집계 시작일 이전 날짜는 잘라낸다
 * (기록이 없던 기간을 0으로 그리면 "그날 안 뽑았다"로 오해되므로).
 */
export function summarizeGenerationStats(
  stats: GenerationStats,
  rangeDays: number,
  today: string = localDay()
): StatsSummary {
  let start = shiftDay(today, -(rangeDays - 1))
  if (stats.since && stats.since > start) start = stats.since
  if (start > today) start = today

  const days: StatsDay[] = []
  const index = new Map<string, StatsDay>()
  for (let day = start; day <= today; day = shiftDay(day, 1)) {
    const entry: StatsDay = { day, ...emptyCounts(), total: 0, anlas: 0 }
    days.push(entry)
    index.set(day, entry)
  }

  const period = { ...emptyCounts(), total: 0, anlas: 0 }
  const kinds = new Map<string, number>()
  let todayCount = 0
  let allTime = 0
  for (const row of stats.rows) {
    const category = generationCategory(row.kind)
    if (!category) continue
    allTime += row.count
    if (row.day === today) todayCount += row.count
    const entry = index.get(row.day)
    if (!entry) continue
    entry[category] += row.count
    entry.total += row.count
    period[category] += row.count
    period.total += row.count
    kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + row.count)
  }
  for (const { day, spent } of stats.anlas) {
    const entry = index.get(day)
    if (!entry) continue
    entry.anlas += spent
    period.anlas += spent
  }

  return {
    days,
    period,
    kinds: [...kinds]
      .map(([kind, count]) => ({ kind, category: generationCategory(kind)!, count }))
      .sort((a, b) => b.count - a.count),
    today: todayCount,
    allTime
  }
}

/** 축 눈금 — 최대값을 덮는 깔끔한 단위(1·2·5×10ⁿ)로 3~5칸 */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1]
  const rough = max / 4
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 10 * magnitude
  const unit = Math.max(1, step)
  const top = Math.ceil(max / unit) * unit
  const ticks: number[] = []
  for (let v = 0; v <= top; v += unit) ticks.push(v)
  return ticks
}
