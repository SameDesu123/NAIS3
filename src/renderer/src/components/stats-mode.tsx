import {
  CalendarDays,
  ChartColumn,
  Coins,
  Images,
  Sigma,
  Table2,
  X,
  type LucideIcon
} from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MessageId } from '@shared/i18n'
import {
  GENERATION_CATEGORIES,
  niceTicks,
  summarizeGenerationStats,
  type GenerationCategory,
  type GenerationStats,
  type StatsDay
} from '@shared/generation-stats'
import { kindMeta } from '../lib/kind-icon'
import { useLanguageStore, useT } from '../lib/i18n'
import { cn } from '../lib/utils'
import { useLayoutStore } from '../stores/layout-store'

const RANGES = [7, 30, 90] as const
type Range = (typeof RANGES)[number]
const RANGE_KEY = 'stats_range'

/** 범주 표시 정보 — 색은 main.css의 --stat-* 토큰 (라이트/다크 각각 검증된 단계) */
const CATEGORY: Record<GenerationCategory, { label: MessageId; color: string }> = {
  general: { label: 'ui.statsGeneral', color: 'var(--stat-general)' },
  scene: { label: 'ui.statsScene', color: 'var(--stat-scene)' },
  director: { label: 'ui.statsDirector', color: 'var(--stat-director)' }
}

const PLOT_HEIGHT = 200

function readRange(): Range {
  try {
    const saved = Number(localStorage.getItem(RANGE_KEY))
    return (RANGES as readonly number[]).includes(saved) ? (saved as Range) : 30
  } catch {
    return 30
  }
}

function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function fmt(n: number): string {
  return n.toLocaleString()
}

/**
 * 생성 통계 페이지 — 일반/씬/디렉터 구분 일별 생성 수와 Anlas 소모.
 * 데이터는 날짜×종류 카운터라 가볍고, 큐 변화 때마다 다시 읽어 실시간으로 갱신된다.
 */
export function StatsMode(): React.JSX.Element {
  const t = useT()
  const [stats, setStats] = useState<GenerationStats | null>(null)
  const [range, setRangeState] = useState<Range>(readRange)
  const [showTable, setShowTable] = useState(false)
  const close = (): void => useLayoutStore.getState().setStatsOpen(false)

  // Esc로 닫기 — 다이얼로그가 떠 있으면 그쪽이 먼저 닫히도록 양보한다
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      useLayoutStore.getState().setStatsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const setRange = (next: Range): void => {
    setRangeState(next)
    try {
      localStorage.setItem(RANGE_KEY, String(next))
    } catch {
      // 저장 불가 환경이면 이번 세션에서만 유지
    }
  }

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = (): void => {
      void window.nais.invoke('stats:generation', undefined).then((next) => {
        if (alive) setStats(next)
      })
    }
    load()
    // 생성이 끝날 때마다 큐 이벤트가 오므로 묶어서 한 번만 다시 읽는다
    const off = window.nais.on('queue:changed', () => {
      clearTimeout(timer)
      timer = setTimeout(load, 400)
    })
    return () => {
      alive = false
      clearTimeout(timer)
      off()
    }
  }, [])

  const summary = useMemo(
    () => (stats ? summarizeGenerationStats(stats, range) : null),
    [stats, range]
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface">
      <header className="flex flex-wrap items-end justify-between gap-3 px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-semibold text-ink">{t('ui.generationStats')}</h2>
          {stats?.since && (
            <p className="mt-0.5 text-[12px] text-faint">
              {t('ui.statsSinceValue', parseDay(stats.since).toLocaleDateString())}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {stats?.since && <RangeControl value={range} onChange={setRange} />}
          <button
            onClick={close}
            title={`${t('ui.close')} (Esc)`}
            aria-label={t('ui.close')}
            className="grid size-8 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>
      </header>

      {!stats ? null : !stats.since || !summary ? (
        <EmptyState />
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-5">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Tile icon={CalendarDays} label={t('ui.statsToday')} value={fmt(summary.today)} />
            <Tile
              icon={Images}
              label={t('ui.statsLastValueDays', range)}
              value={fmt(summary.period.total)}
              hint={t(
                'ui.statsDailyAverageValue',
                (summary.period.total / summary.days.length).toFixed(1)
              )}
            />
            <Tile
              icon={Sigma}
              label={t('ui.statsAllTime')}
              value={fmt(summary.allTime)}
              hint={t('ui.statsSinceValue', parseDay(stats.since).toLocaleDateString())}
            />
            <Tile
              icon={Coins}
              iconClassName="text-[#c9a34f]"
              label={t('ui.statsAnlasSpent')}
              value={fmt(summary.period.anlas)}
              hint={t('ui.statsLastValueDays', range)}
            />
          </div>

          <section className="rounded-xl border border-line bg-paper p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[13px] font-semibold text-ink">
                {t('ui.statsDailyGenerations')}
              </h3>
              <div className="flex items-center gap-3">
                <Legend counts={summary.period} />
                <button
                  onClick={() => setShowTable((v) => !v)}
                  title={showTable ? t('ui.statsShowChart') : t('ui.statsShowTable')}
                  aria-label={showTable ? t('ui.statsShowChart') : t('ui.statsShowTable')}
                  className="grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  {showTable ? <ChartColumn size={14} /> : <Table2 size={14} />}
                </button>
              </div>
            </div>
            {showTable ? (
              <DayTable days={summary.days} />
            ) : summary.period.total === 0 ? (
              <div
                className="grid place-items-center text-[12.5px] text-faint"
                style={{ height: PLOT_HEIGHT + 24 }}
              >
                {t('ui.statsNoGenerationsInPeriod')}
              </div>
            ) : (
              <DailyChart days={summary.days} />
            )}
          </section>

          <Breakdown summary={summary} />
        </div>
      )}
    </div>
  )
}

function RangeControl({
  value,
  onChange
}: {
  value: Range
  onChange: (range: Range) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div
      role="radiogroup"
      aria-label={t('ui.statsRange')}
      className="flex items-center gap-0.5 rounded-full border border-line bg-paper p-0.5"
    >
      {RANGES.map((r) => {
        const active = r === value
        return (
          <button
            key={r}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(r)}
            className={cn(
              'relative z-0 rounded-full px-3 py-1 text-[12px] font-medium transition-colors',
              active ? 'text-ink' : 'text-muted hover:text-ink'
            )}
          >
            {active && (
              <motion.span
                layoutId="statsRangeActive"
                className="absolute inset-0 -z-10 rounded-full bg-ink/[0.08]"
                transition={{ type: 'spring', bounce: 0.2, duration: 0.5 }}
              />
            )}
            {t('ui.statsValueDays', r)}
          </button>
        )
      })}
    </div>
  )
}

function Tile({
  icon: Icon,
  iconClassName,
  label,
  value,
  hint
}: {
  icon: LucideIcon
  iconClassName?: string
  label: string
  value: string
  hint?: string
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-line bg-paper px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12px] text-muted">{label}</span>
        <Icon size={14} className={cn('shrink-0 text-faint', iconClassName)} />
      </div>
      <div className="mt-1 text-[24px] font-semibold leading-tight text-ink">{value}</div>
      {hint && <div className="mt-0.5 truncate text-[11.5px] text-faint">{hint}</div>}
    </div>
  )
}

function Swatch({ category }: { category: GenerationCategory }): React.JSX.Element {
  return (
    <span
      className="inline-block size-2.5 shrink-0 rounded-[3px]"
      style={{ background: CATEGORY[category].color }}
    />
  )
}

function Legend({ counts }: { counts: Record<GenerationCategory, number> }): React.JSX.Element {
  const t = useT()
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {GENERATION_CATEGORIES.map((c) => (
        <li key={c} className="flex items-center gap-1.5 text-[12px] text-muted">
          <Swatch category={c} />
          {t(CATEGORY[c].label)}
          <span className="tabular-nums text-ink">{fmt(counts[c])}</span>
        </li>
      ))}
    </ul>
  )
}

/** 일별 누적 막대 — 아래부터 일반·씬·디렉터 순, 세그먼트 사이 2px 간격, 윗끝만 둥글게 */
function DailyChart({ days }: { days: StatsDay[] }): React.JSX.Element {
  const t = useT()
  const lang = useLanguageStore((s) => s.lang)
  const [hover, setHover] = useState<number | null>(null)
  const ticks = niceTicks(Math.max(...days.map((d) => d.total)))
  const top = ticks[ticks.length - 1]
  const n = days.length
  // x축 라벨은 실제 폭 기준으로 간격을 정한다 (라벨 하나당 약 52px)
  const axisRef = useRef<HTMLDivElement>(null)
  const [axisWidth, setAxisWidth] = useState(600)
  useEffect(() => {
    const el = axisRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setAxisWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const labelStep = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(axisWidth / 52))))
  const peak = days.reduce((best, d, i) => (d.total > days[best].total ? i : best), 0)
  const short = new Intl.DateTimeFormat(lang, { month: 'numeric', day: 'numeric' })
  const long = new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric', weekday: 'short' })
  const hovered = hover === null ? null : days[hover]

  return (
    <div className="flex gap-2 select-none">
      {/* y축 눈금 */}
      <div className="relative w-8 shrink-0" style={{ height: PLOT_HEIGHT }}>
        {ticks.map((v) => (
          <span
            key={v}
            className="absolute right-0 font-mono text-[10.5px] tabular-nums text-faint"
            style={{ bottom: `${(v / top) * 100}%`, transform: 'translateY(50%)' }}
          >
            {fmt(v)}
          </span>
        ))}
      </div>

      <div className="min-w-0 flex-1">
        <div
          className="relative"
          style={{ height: PLOT_HEIGHT }}
          onMouseLeave={() => setHover(null)}
        >
          {/* 그리드 (실선 헤어라인) */}
          {ticks.map((v) => (
            <div
              key={v}
              className={cn('absolute inset-x-0 h-px', v === 0 ? 'bg-line' : 'bg-line/60')}
              style={{ bottom: `${(v / top) * 100}%` }}
            />
          ))}

          <div className="absolute inset-0 flex items-stretch">
            {days.map((d, i) => {
              const segments = GENERATION_CATEGORIES.filter((c) => d[c] > 0)
              return (
                <div
                  key={d.day}
                  tabIndex={0}
                  aria-label={`${long.format(parseDay(d.day))}: ${t('ui.statsImagesValue', d.total)}`}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  className={cn(
                    'relative flex min-w-0 flex-1 flex-col items-center justify-end rounded-md outline-none transition-colors',
                    hover === i && 'bg-ink/[0.04]'
                  )}
                >
                  {i === peak && d.total > 0 && (
                    <span className="mb-1 font-mono text-[10.5px] tabular-nums text-muted">
                      {fmt(d.total)}
                    </span>
                  )}
                  <motion.div
                    className="flex w-[70%] max-w-6 flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px]"
                    initial={{ height: 0 }}
                    animate={{ height: (d.total / top) * PLOT_HEIGHT }}
                    transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: i * 0.008 }}
                  >
                    {segments.map((c) => (
                      <div
                        key={c}
                        className="w-full shrink-0"
                        style={{ flexGrow: d[c], flexBasis: 0, background: CATEGORY[c].color }}
                      />
                    ))}
                  </motion.div>
                </div>
              )
            })}
          </div>

          {hovered && hover !== null && (
            <ChartTooltip
              day={hovered}
              title={long.format(parseDay(hovered.day))}
              index={hover}
              count={n}
            />
          )}
        </div>

        {/* x축 날짜 — 최신 날짜 기준으로 간격을 두고 표시 */}
        <div ref={axisRef} className="mt-1.5 flex">
          {days.map((d, i) => (
            <div
              key={d.day}
              // 양 끝 라벨은 카드 밖으로 잘리지 않게 안쪽으로 정렬
              className={cn(
                'flex min-w-0 flex-1',
                n > 1 && i === n - 1
                  ? 'justify-end'
                  : n > 1 && i === 0
                    ? 'justify-start'
                    : 'justify-center'
              )}
            >
              {(n - 1 - i) % labelStep === 0 && (
                <span className="whitespace-nowrap font-mono text-[10.5px] text-faint">
                  {short.format(parseDay(d.day))}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ChartTooltip({
  day,
  title,
  index,
  count
}: {
  day: StatsDay
  title: string
  index: number
  count: number
}): React.JSX.Element {
  const t = useT()
  // 막대를 가리지 않게 옆에 띄운다 — 왼쪽 절반은 오른쪽에, 오른쪽 절반은 왼쪽에
  const onRight = index < count / 2
  const edge = ((onRight ? index + 1 : index) / count) * 100
  const style = onRight
    ? { left: `calc(${edge}% + 8px)` }
    : { left: `calc(${edge}% - 8px)`, transform: 'translateX(-100%)' }
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 min-w-40 rounded-lg border border-line bg-surface px-3 py-2 text-[12px] shadow-xl"
      style={style}
    >
      <div className="mb-1.5 font-medium text-ink">{title}</div>
      <ul className="space-y-1">
        {GENERATION_CATEGORIES.map((c) => (
          <li key={c} className="flex items-center gap-2 text-muted">
            <Swatch category={c} />
            <span className="flex-1">{t(CATEGORY[c].label)}</span>
            <span className="tabular-nums text-ink">{fmt(day[c])}</span>
          </li>
        ))}
      </ul>
      <div className="mt-1.5 flex justify-between border-t border-line pt-1.5 text-muted">
        <span>{t('ui.statsTotal')}</span>
        <span className="tabular-nums font-medium text-ink">{fmt(day.total)}</span>
      </div>
      {day.anlas > 0 && (
        <div className="mt-1 flex items-center justify-between text-muted">
          <span className="flex items-center gap-1">
            <Coins size={11} className="text-[#c9a34f]" />
            {t('ui.statsAnlasSpent')}
          </span>
          <span className="tabular-nums text-ink">{fmt(day.anlas)}</span>
        </div>
      )}
    </div>
  )
}

/** 차트와 같은 데이터를 표로 (최근 날짜가 위) */
function DayTable({ days }: { days: StatsDay[] }): React.JSX.Element {
  const t = useT()
  const rows = [...days].reverse()
  const head = 'px-2 py-1.5 text-right font-medium text-muted'
  const cell = 'px-2 py-1.5 text-right tabular-nums'
  return (
    <div className="max-h-[320px] overflow-y-auto">
      <table className="w-full text-[12px]">
        <thead className="sticky top-0 bg-paper">
          <tr className="border-b border-line">
            <th className={cn(head, 'text-left')}>{t('ui.statsDate')}</th>
            {GENERATION_CATEGORIES.map((c) => (
              <th key={c} className={head}>
                <span className="inline-flex items-center gap-1.5">
                  <Swatch category={c} />
                  {t(CATEGORY[c].label)}
                </span>
              </th>
            ))}
            <th className={head}>{t('ui.statsTotal')}</th>
            <th className={head}>Anlas</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.day} className="border-b border-line/60 last:border-0">
              <td className="px-2 py-1.5 font-mono text-muted">{d.day}</td>
              {GENERATION_CATEGORIES.map((c) => (
                <td key={c} className={cn(cell, d[c] === 0 ? 'text-faint' : 'text-ink')}>
                  {fmt(d[c])}
                </td>
              ))}
              <td className={cn(cell, 'font-medium text-ink')}>{fmt(d.total)}</td>
              <td className={cn(cell, d.anlas === 0 ? 'text-faint' : 'text-ink')}>
                {fmt(d.anlas)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 범주별 비중 + 세부 종류(t2i·i2i·인페인트, 디렉터 툴별) */
function Breakdown({
  summary
}: {
  summary: ReturnType<typeof summarizeGenerationStats>
}): React.JSX.Element {
  const t = useT()
  const total = summary.period.total
  return (
    <section className="rounded-xl border border-line bg-paper p-4">
      <h3 className="mb-3 text-[13px] font-semibold text-ink">{t('ui.statsBreakdown')}</h3>
      <div className="grid gap-4 lg:grid-cols-3">
        {GENERATION_CATEGORIES.map((c) => {
          const count = summary.period[c]
          const share = total > 0 ? count / total : 0
          const kinds = summary.kinds.filter((k) => k.category === c)
          return (
            <div key={c} className="min-w-0">
              <div className="flex items-center gap-1.5 text-[12.5px]">
                <Swatch category={c} />
                <span className="flex-1 truncate text-ink">{t(CATEGORY[c].label)}</span>
                <span className="tabular-nums font-medium text-ink">{fmt(count)}</span>
                <span className="w-10 text-right tabular-nums text-faint">
                  {Math.round(share * 100)}%
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                <motion.div
                  className="h-full rounded-full"
                  style={{ background: CATEGORY[c].color }}
                  initial={{ width: 0 }}
                  animate={{ width: `${share * 100}%` }}
                  transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                />
              </div>
              {c !== 'scene' && kinds.length > 0 && (
                <ul className="mt-2.5 flex flex-wrap gap-1.5">
                  {kinds.map((k) => {
                    const meta = kindMeta(k.kind)
                    return (
                      <li
                        key={k.kind}
                        className="flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11.5px] text-muted"
                      >
                        <meta.Icon size={11} className={meta.className} />
                        {t(meta.label)}
                        <span className="tabular-nums text-ink">{fmt(k.count)}</span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function EmptyState(): React.JSX.Element {
  const t = useT()
  return (
    <div className="grid flex-1 place-items-center p-8">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-accent-soft text-accent">
          <ChartColumn size={22} />
        </div>
        <div className="text-[14px] font-medium text-ink">{t('ui.statsNoRecordsYet')}</div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
          {t('ui.statsCountingStartsAfterUpdate')}
        </p>
      </div>
    </div>
  )
}
