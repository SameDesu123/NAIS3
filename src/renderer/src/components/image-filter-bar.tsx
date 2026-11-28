import { Loader2, Search, SlidersHorizontal, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  countFilterSelections,
  hasActiveSearchFilter,
  localDateRangeToUtc,
  recentLocalDays,
  SEARCH_KIND_GROUPS,
  SEARCH_MODELS,
  searchModelLabel,
  utcBoundToLocalDate
} from '@shared/search-query'
import type { ImageSearchFilter, SearchFacets, SearchKindGroup } from '@shared/types'
import { useT } from '../lib/i18n'
import { kindMeta } from '../lib/kind-icon'
import { cn } from '../lib/utils'
import { useGenerationStore } from '../stores/generation-store'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Switch } from './ui/switch'

const QUERY_DEBOUNCE_MS = 200

interface ImageSearchPanelProps {
  id: string
  scope: 'history' | 'library'
  filter: ImageSearchFilter
  onChange: (filter: ImageSearchFilter) => void
  open: boolean
  onClose: () => void
  /** 헤더의 알약 버튼 — 바깥 클릭 판정에서 빼고, 닫을 때 포커스를 돌려준다 */
  anchorRef: RefObject<HTMLButtonElement | null>
  /** 좁은 패널(히스토리) — 칩을 한 줄로 줄이고 팝오버를 패널 폭에 맞춘다 */
  compact?: boolean
  searchAllStacks?: boolean
  onSearchAllStacksChange?: (value: boolean) => void
  /** 칩 아래에 덧붙일 안내 (라이브러리: 필터 중 정렬 꺼짐) */
  footer?: React.ReactNode
  className?: string
}

/** 검색 조건 수 — 검색어 1 + 팝오버 선택 수 */
function conditionCount(filter: ImageSearchFilter): number {
  return (filter.query?.trim() ? 1 : 0) + countFilterSelections(filter)
}

/** 헤더에 들어가는 검색 알약. 누르면 헤더 아래에 검색 패널이 뜬다 */
export function ImageSearchPill({
  open,
  filter,
  panelId,
  onToggle,
  buttonRef,
  className
}: {
  open: boolean
  filter: ImageSearchFilter
  panelId: string
  onToggle: () => void
  buttonRef: RefObject<HTMLButtonElement | null>
  className?: string
}): React.JSX.Element {
  const t = useT()
  const active = hasActiveSearchFilter(filter)
  const count = conditionCount(filter)
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-expanded={open}
      aria-controls={panelId}
      title={t('ui.searchImages')}
      className={cn(
        'no-drag flex h-6 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[11.5px] font-medium transition-colors',
        active
          ? 'border-accent/60 bg-accent/10 text-accent-ink'
          : open
            ? 'border-line bg-surface-2 text-ink'
            : 'border-line text-muted hover:bg-surface-2 hover:text-ink',
        className
      )}
      onClick={onToggle}
    >
      <Search size={12} />
      {t('ui.search')}
      {active && count > 0 && (
        <span className="grid min-w-[15px] place-items-center rounded-full bg-accent px-1 text-[9.5px] font-semibold leading-[15px] text-on-accent">
          {count}
        </span>
      )}
    </button>
  )
}

/** 목록 우하단에 뜨는 검색 결과 수 (필터가 있을 때만) */
export function ImageSearchCount({
  filter,
  total,
  unfilteredTotal
}: {
  filter: ImageSearchFilter
  total: number
  unfilteredTotal: number
}): React.JSX.Element | null {
  const indexing = useGenerationStore((s) => s.searchIndex?.indexing === true)
  if (!hasActiveSearchFilter(filter)) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute bottom-2.5 right-2.5 z-10 flex items-center gap-1 rounded-full border border-line bg-surface/90 px-2.5 py-1 font-mono text-[11px] text-muted shadow-sm backdrop-blur"
    >
      {indexing && <Loader2 size={11} className="animate-spin motion-reduce:animate-none" />}
      {total.toLocaleString()} / {unfilteredTotal.toLocaleString()}
    </div>
  )
}

function without<T>(values: readonly T[] | undefined, value: T): T[] {
  return (values ?? []).filter((v) => v !== value)
}

function toggled<T>(values: readonly T[] | undefined, value: T): T[] {
  return values?.includes(value) ? without(values, value) : [...(values ?? []), value]
}

/** 빈 배열·null 값은 지운다 — 필터가 비면 {}가 되어 평소 목록으로 돌아간다 */
function cleaned(filter: ImageSearchFilter): ImageSearchFilter {
  const out: ImageSearchFilter = {}
  if (filter.query?.trim()) out.query = filter.query
  if (filter.artists?.length) out.artists = filter.artists
  if (filter.characters?.length) out.characters = filter.characters
  if (filter.models?.length) out.models = filter.models
  if (filter.kinds?.length) out.kinds = filter.kinds
  if (typeof filter.seed === 'number') out.seed = filter.seed
  if (filter.dateFromUtc) out.dateFromUtc = filter.dateFromUtc
  if (filter.dateToUtc) out.dateToUtc = filter.dateToUtc
  if (filter.favoritesOnly) out.favoritesOnly = true
  return out
}

/**
 * 히스토리·라이브러리 공용 검색 패널 — 헤더 아래에 떠 있는다. 닫아도 언마운트하지 않고 숨기기만
 * 해서 입력 중인 검색어·조합 상태를 잃지 않는다 (조건은 닫아도 그대로 걸려 있다).
 * 검색어는 200ms 디바운스로 반영하고, 한글 조합 중에는 반영하지 않는다 (조합이 끝나면 바로).
 * 필터 팝오버는 열 때 색인의 실제 값(모델·종류·작가)을 받는다.
 */
export function ImageSearchPanel({
  id,
  scope,
  filter,
  onChange,
  open,
  onClose,
  anchorRef,
  compact = false,
  searchAllStacks,
  onSearchAllStacksChange,
  footer,
  className
}: ImageSearchPanelProps): React.JSX.Element {
  const t = useT()
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const onCloseRef = useRef(onClose)
  useLayoutEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // 열리면 검색창에 포커스
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // 바깥을 누르면 닫는다 — 알약과 필터 팝오버(포털)는 바깥으로 치지 않는다
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Element | null
      if (!target) return
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      if (target.closest('[data-radix-popper-content-wrapper]')) return
      onCloseRef.current()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, anchorRef])

  const close = (): void => {
    onClose()
    anchorRef.current?.focus()
  }
  const searchIndex = useGenerationStore((s) => s.searchIndex)
  const [draft, setDraft] = useState(filter.query ?? '')
  const composing = useRef(false)
  const committed = useRef(filter.query ?? '')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const filterRef = useRef(filter)
  // 디바운스된 검색어가 그 사이 팝오버에서 바꾼 값을 덮지 않게 최신 필터를 들고 있는다
  useLayoutEffect(() => {
    filterRef.current = filter
  }, [filter])

  // 밖에서 검색어가 바뀌면(초기화 등) 입력란도 따라간다
  useEffect(() => {
    const query = filter.query ?? ''
    if (query !== committed.current) {
      committed.current = query
      // 밖(초기화·ESC)에서 바뀐 검색어만 입력란에 되돌린다 — 입력 중 반영된 값은 덮지 않는다
      setDraft(query)
    }
  }, [filter.query])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const commitQuery = (value: string): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (value === committed.current) return
    committed.current = value
    onChange(cleaned({ ...filterRef.current, query: value }))
  }

  const scheduleQuery = (value: string): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => commitQuery(value), QUERY_DEBOUNCE_MS)
  }

  const update = (patch: Partial<ImageSearchFilter>): void => {
    onChange(cleaned({ ...filterRef.current, query: committed.current, ...patch }))
  }

  const active = hasActiveSearchFilter(filter)
  const selections = countFilterSelections(filter)
  const indexing = searchIndex?.indexing === true
  const indexPercent =
    searchIndex && searchIndex.total > 0
      ? Math.min(99, Math.floor((searchIndex.indexed / searchIndex.total) * 100))
      : 0

  // 칩은 값만 들고, 지울 때 붙일 patch는 클릭 때 적용한다
  const chips: { key: string; label: string; patch: Partial<ImageSearchFilter> }[] = [
    ...(filter.models ?? []).map((id) => ({
      key: `model-${id}`,
      label: searchModelLabel(id),
      patch: { models: without(filter.models, id) }
    })),
    ...(filter.kinds ?? []).map((kind) => ({
      key: `kind-${kind}`,
      label: t(kindMeta(kind).label),
      patch: { kinds: without(filter.kinds, kind) }
    })),
    ...(filter.artists ?? []).map((name) => ({
      key: `artist-${name}`,
      label: `artist:${name}`,
      patch: { artists: without(filter.artists, name) }
    })),
    ...(filter.characters ?? []).map((name) => ({
      key: `char-${name}`,
      label: `char:${name}`,
      patch: { characters: without(filter.characters, name) }
    })),
    ...(typeof filter.seed === 'number'
      ? [{ key: 'seed', label: `seed:${filter.seed}`, patch: { seed: null } }]
      : []),
    ...(filter.dateFromUtc || filter.dateToUtc
      ? [
          {
            key: 'date',
            label: `${utcBoundToLocalDate(filter.dateFromUtc) || '…'} – ${utcBoundToLocalDate(filter.dateToUtc) || '…'}`,
            patch: { dateFromUtc: null, dateToUtc: null }
          }
        ]
      : []),
    ...(filter.favoritesOnly
      ? [
          {
            key: 'favorites',
            label: t('ui.searchFavoritesOnly'),
            patch: { favoritesOnly: false }
          }
        ]
      : [])
  ]

  return (
    <div
      ref={panelRef}
      id={id}
      role="search"
      aria-label={t('ui.searchImages')}
      hidden={!open}
      className={cn(
        'absolute z-20 flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-1.5 shadow-lg',
        className
      )}
      onKeyDown={(e) => {
        // 패널 안(팝오버 포털 제외)의 ESC — 검색어 지우기는 입력란이 먼저 처리한다
        if (e.key !== 'Escape' || e.defaultPrevented) return
        if (!e.currentTarget.contains(e.target as Node)) return
        e.preventDefault()
        e.stopPropagation()
        close()
      }}
    >
      <div className="flex items-center gap-1">
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            ref={inputRef}
            type="search"
            value={draft}
            aria-label={t('ui.searchImages')}
            placeholder={t('ui.searchImages')}
            spellCheck={false}
            className="h-7 w-full rounded-md border border-line bg-paper pl-7 pr-6 text-[12.5px] text-ink outline-none transition-colors placeholder:text-faint focus:border-accent/50 [&::-webkit-search-cancel-button]:hidden"
            onChange={(e) => {
              setDraft(e.target.value)
              if (!composing.current) scheduleQuery(e.target.value)
            }}
            onCompositionStart={() => {
              composing.current = true
            }}
            onCompositionEnd={(e) => {
              composing.current = false
              scheduleQuery(e.currentTarget.value)
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter') commitQuery(e.currentTarget.value)
              if (e.key === 'Escape' && draft) {
                // 검색어부터 지운다 — 바깥(스택 나가기 등)의 ESC는 다음 번에
                e.preventDefault()
                e.stopPropagation()
                setDraft('')
                commitQuery('')
              }
            }}
          />
          {draft && (
            <button
              type="button"
              className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-faint hover:text-ink"
              aria-label={t('ui.searchClearQuery')}
              title={t('ui.searchClearQuery')}
              onClick={() => {
                setDraft('')
                commitQuery('')
              }}
            >
              <X size={12} />
            </button>
          )}
        </div>
        <FilterPopover
          scope={scope}
          filter={filter}
          compact={compact}
          selections={selections}
          update={update}
          searchAllStacks={searchAllStacks}
          onSearchAllStacksChange={onSearchAllStacksChange}
          onReset={() => {
            setDraft('')
            committed.current = ''
            onChange({})
          }}
        />
      </div>

      {(chips.length > 0 || indexing) && (
        <div
          className={cn(
            'flex items-center gap-1 text-[11px]',
            compact ? 'no-scrollbar overflow-x-auto' : 'flex-wrap'
          )}
        >
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="flex max-w-[180px] shrink-0 items-center gap-0.5 rounded-full border border-line bg-surface-2 py-0.5 pl-2 pr-0.5 text-muted"
            >
              <span className="truncate">{chip.label}</span>
              <button
                type="button"
                className="grid size-4 place-items-center rounded-full text-faint hover:bg-paper hover:text-ink"
                aria-label={t('ui.searchRemoveFilter', chip.label)}
                title={t('ui.searchRemoveFilter', chip.label)}
                onClick={() => update(chip.patch)}
              >
                <X size={10} />
              </button>
            </span>
          ))}
          {indexing && (
            <span
              className="flex shrink-0 items-center gap-1 text-faint"
              title={t('ui.searchIndexingHint')}
              role="status"
            >
              <Loader2 size={11} className="animate-spin motion-reduce:animate-none" />
              {t('ui.searchIndexing', indexPercent)}
            </span>
          )}
        </div>
      )}
      {active && footer}
    </div>
  )
}

function FilterPopover({
  scope,
  filter,
  compact,
  selections,
  update,
  searchAllStacks,
  onSearchAllStacksChange,
  onReset
}: {
  scope: 'history' | 'library'
  filter: ImageSearchFilter
  compact: boolean
  selections: number
  update: (patch: Partial<ImageSearchFilter>) => void
  searchAllStacks?: boolean
  onSearchAllStacksChange?: (value: boolean) => void
  onReset: () => void
}): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [facets, setFacets] = useState<SearchFacets | null>(null)
  const [artistDraft, setArtistDraft] = useState('')
  const [characterDraft, setCharacterDraft] = useState('')
  const [seedDraft, setSeedDraft] = useState('')

  useEffect(() => {
    if (!open) return
    let alive = true
    window.nais
      .invoke('search:facets', { scope })
      .then((result) => {
        if (alive) setFacets(result)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [open, scope])

  useEffect(() => {
    // 팝오버를 열 때·칩으로 시드를 뺐을 때 입력란을 필터 값에 맞춘다
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) setSeedDraft(typeof filter.seed === 'number' ? String(filter.seed) : '')
  }, [open, filter.seed])

  const modelCounts = new Map((facets?.models ?? []).map((m) => [m.value, m.count]))
  const kindCounts = new Map((facets?.kinds ?? []).map((k) => [k.value, k.count]))
  // 표준 모델 + 색인에만 있는 모델 (알 수 없는 id는 그대로 보인다)
  const modelIds = [
    ...SEARCH_MODELS.map((m) => m.id),
    ...(facets?.models ?? [])
      .map((m) => m.value)
      .filter((id) => !SEARCH_MODELS.some((m) => m.id === id))
  ]
  const fromDate = utcBoundToLocalDate(filter.dateFromUtc)
  const toDate = utcBoundToLocalDate(filter.dateToUtc)
  const setDates = (from: string, to: string): void => update(localDateRangeToUtc(from, to))

  const addArtist = (): void => {
    const name = artistDraft.trim().replace(/^artist:\s*/i, '')
    if (name && !filter.artists?.includes(name))
      update({ artists: [...(filter.artists ?? []), name] })
    setArtistDraft('')
  }
  const addCharacter = (): void => {
    const name = characterDraft.trim()
    if (name && !filter.characters?.includes(name)) {
      update({ characters: [...(filter.characters ?? []), name] })
    }
    setCharacterDraft('')
  }
  const commitSeed = (): void => {
    const value = seedDraft.trim()
    if (!value) {
      update({ seed: null })
      return
    }
    const seed = Number(value)
    if (Number.isInteger(seed) && seed >= 0 && seed <= 4294967295) update({ seed })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('ui.searchFilters')}
          title={t('ui.searchFilters')}
          className={cn(
            'relative grid size-7 shrink-0 place-items-center rounded-md border transition-colors',
            selections > 0
              ? 'border-accent/60 bg-accent/10 text-accent-ink'
              : 'border-line text-muted hover:bg-surface-2 hover:text-ink'
          )}
        >
          <SlidersHorizontal size={13} />
          {selections > 0 && (
            <span className="absolute -right-1 -top-1 grid min-w-[14px] place-items-center rounded-full bg-accent px-0.5 text-[9px] font-semibold leading-[14px] text-on-accent">
              {selections}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={compact ? 'start' : 'end'}
        // 팝오버를 닫는 ESC가 검색 패널·라이브러리(필터 해제·스택 나가기)까지 가지 않게
        onEscapeKeyDown={(e) => e.stopPropagation()}
        className={cn(
          'flex max-h-[70vh] flex-col gap-3 overflow-y-auto p-3',
          compact ? 'w-[300px]' : 'w-[360px]'
        )}
      >
        <Section title={t('ui.searchModel')}>
          {modelIds.map((id) => (
            <ToggleChip
              key={id}
              label={searchModelLabel(id)}
              count={modelCounts.get(id)}
              pressed={filter.models?.includes(id) ?? false}
              onClick={() => update({ models: toggled(filter.models, id) })}
            />
          ))}
        </Section>

        <Section title={t('ui.searchKind')}>
          {SEARCH_KIND_GROUPS.map((kind: SearchKindGroup) => (
            <ToggleChip
              key={kind}
              label={t(kindMeta(kind).label)}
              count={kindCounts.get(kind)}
              pressed={filter.kinds?.includes(kind) ?? false}
              onClick={() => update({ kinds: toggled(filter.kinds, kind) })}
            />
          ))}
        </Section>

        <Section title={t('ui.searchArtists')}>
          <TextAdd
            value={artistDraft}
            onChange={setArtistDraft}
            onAdd={addArtist}
            label={t('ui.searchArtists')}
            placeholder="artist:…"
          />
          {(facets?.topArtists ?? []).map((artist) => (
            <ToggleChip
              key={artist.value}
              label={artist.value}
              count={artist.count}
              pressed={filter.artists?.includes(artist.value) ?? false}
              onClick={() => update({ artists: toggled(filter.artists, artist.value) })}
            />
          ))}
        </Section>

        <Section title={t('ui.searchCharacter')}>
          <TextAdd
            value={characterDraft}
            onChange={setCharacterDraft}
            onAdd={addCharacter}
            label={t('ui.searchCharacter')}
          />
        </Section>

        <Section title={t('ui.searchSeed')}>
          <input
            inputMode="numeric"
            value={seedDraft}
            aria-label={t('ui.searchSeed')}
            className="h-7 w-full rounded-md border border-line bg-paper px-2 font-mono text-[12px] text-ink outline-none focus:border-accent/50"
            onChange={(e) => setSeedDraft(e.target.value.replace(/\D/g, ''))}
            onBlur={commitSeed}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitSeed()
            }}
          />
        </Section>

        <Section title={t('ui.searchDate')}>
          <div className="flex w-full items-center gap-1">
            <input
              type="date"
              value={fromDate}
              max={toDate || undefined}
              aria-label={t('ui.searchDateFrom')}
              className="h-7 min-w-0 flex-1 rounded-md border border-line bg-paper px-1.5 text-[12px] text-ink outline-none focus:border-accent/50"
              onChange={(e) => setDates(e.target.value, toDate)}
            />
            <span className="text-faint">–</span>
            <input
              type="date"
              value={toDate}
              min={fromDate || undefined}
              aria-label={t('ui.searchDateTo')}
              className="h-7 min-w-0 flex-1 rounded-md border border-line bg-paper px-1.5 text-[12px] text-ink outline-none focus:border-accent/50"
              onChange={(e) => setDates(fromDate, e.target.value)}
            />
          </div>
          {(
            [
              [1, 'ui.searchToday'],
              [7, 'ui.searchLast7Days'],
              [30, 'ui.searchLast30Days']
            ] as const
          ).map(([days, label]) => {
            const range = recentLocalDays(days)
            return (
              <ToggleChip
                key={days}
                label={t(label)}
                pressed={fromDate === range.from && toDate === range.to}
                onClick={() => setDates(range.from, range.to)}
              />
            )
          })}
        </Section>

        {scope === 'history' && (
          <SwitchRow
            label={t('ui.searchFavoritesOnly')}
            checked={filter.favoritesOnly === true}
            onChange={(favoritesOnly) => update({ favoritesOnly })}
          />
        )}
        {scope === 'library' && onSearchAllStacksChange && (
          <SwitchRow
            label={t('ui.searchAllStacks')}
            checked={searchAllStacks === true}
            onChange={onSearchAllStacksChange}
          />
        )}

        <p className="text-[11px] leading-relaxed text-faint">{t('ui.searchSyntaxHint')}</p>

        <button
          type="button"
          className="h-7 rounded-md border border-line text-[12px] text-muted transition-colors hover:bg-surface-2 hover:text-ink"
          onClick={() => {
            onReset()
            setOpen(false)
          }}
        >
          {t('ui.searchReset')}
        </button>
      </PopoverContent>
    </Popover>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div role="group" aria-label={title} className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-muted">{title}</span>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  )
}

function ToggleChip({
  label,
  count,
  pressed,
  onClick
}: {
  label: string
  count?: number
  pressed: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        'flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] transition-colors',
        pressed
          ? 'border-accent bg-accent text-on-accent'
          : 'border-line text-muted hover:bg-surface-2 hover:text-ink'
      )}
      onClick={onClick}
    >
      <span className="truncate">{label}</span>
      {count !== undefined && (
        <span className={cn('font-mono text-[10px]', pressed ? 'opacity-80' : 'text-faint')}>
          {count}
        </span>
      )}
    </button>
  )
}

function TextAdd({
  value,
  onChange,
  onAdd,
  label,
  placeholder
}: {
  value: string
  onChange: (value: string) => void
  onAdd: () => void
  label: string
  placeholder?: string
}): React.JSX.Element {
  return (
    <input
      value={value}
      aria-label={label}
      placeholder={placeholder}
      spellCheck={false}
      className="h-7 w-full rounded-md border border-line bg-paper px-2 text-[12px] text-ink outline-none placeholder:text-faint focus:border-accent/50"
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          onAdd()
        }
      }}
      onBlur={() => {
        if (value.trim()) onAdd()
      }}
    />
  )
}

function SwitchRow({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2 text-[12px] text-ink">
      {label}
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}
