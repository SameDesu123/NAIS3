import { Check, Copy, ImageOff, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ImageMetadata } from '@shared/types'
import { isSplitMeta, useMetadataStore } from '../stores/metadata-store'
import { cn } from '../lib/utils'
import { useT } from '../lib/i18n'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

const UC_LABELS: Record<number, string> = { 0: 'Heavy', 1: 'Light', 3: 'Human Focus', 4: 'None' }

/** 캐릭터 카드 번호 배지 색 — Tailwind가 스캔할 수 있게 클래스 문자열을 그대로 둔다 */
const CHARACTER_TINTS = [
  'bg-hue-sky/15 text-hue-sky',
  'bg-hue-pink/15 text-hue-pink',
  'bg-hue-emerald/15 text-hue-emerald',
  'bg-hue-amber/15 text-hue-amber',
  'bg-hue-violet/15 text-hue-violet',
  'bg-hue-orange/15 text-hue-orange'
]

type Selection = Record<string, boolean>

interface ParamRow {
  k: string
  label: string
  value?: string | number
}

function paramRows(meta: ImageMetadata, t: ReturnType<typeof useT>): ParamRow[] {
  return [
    {
      k: 'resolution',
      label: t('ui.resolution'),
      value: meta.width && meta.height ? `${meta.width}×${meta.height}` : undefined
    },
    { k: 'seed', label: t('ui.seed'), value: meta.seed },
    { k: 'steps', label: t('ui.steps'), value: meta.steps },
    { k: 'cfgScale', label: 'CFG', value: meta.cfgScale },
    { k: 'cfgRescale', label: 'CFG Rescale', value: meta.cfgRescale },
    { k: 'sampler', label: t('ui.sampler'), value: meta.sampler },
    { k: 'noiseSchedule', label: t('ui.schedule'), value: meta.noiseSchedule },
    { k: 'variety', label: 'Variety+', value: meta.variety ? 'ON' : undefined },
    {
      k: 'quality',
      label: t('ui.qualityTags'),
      value: meta.qualityToggle ? 'ON' : meta.qualityToggle === false ? 'OFF' : undefined
    },
    {
      k: 'ucPreset',
      label: t('ui.ucPreset'),
      value: meta.ucPreset != null ? (UC_LABELS[meta.ucPreset] ?? `#${meta.ucPreset}`) : undefined
    }
  ].filter((row) => row.value != null && row.value !== '')
}

/** 이미지 메타데이터 팝업 — 좌: 이미지+파라미터 / 우: 프롬프트. 체크한 요소만 적용 */
export function MetadataDialog(): React.JSX.Element {
  const t = useT()
  const open = useMetadataStore((s) => s.open)
  const loading = useMetadataStore((s) => s.loading)
  const meta = useMetadataStore((s) => s.meta)
  const error = useMetadataStore((s) => s.error)
  const imageSrc = useMetadataStore((s) => s.imageSrc)
  const close = useMetadataStore((s) => s.close)
  const applyToMain = useMetadataStore((s) => s.applyToMain)

  // 기본 전부 체크, 시드만 해제
  const [sel, setSel] = useState<Selection>({})
  useEffect(() => {
    if (!meta) return
    const timer = setTimeout(() => {
      setSel({
        prompt: true,
        negativePrompt: true,
        characters: true,
        quality: true,
        ucPreset: true,
        seed: false,
        steps: true,
        cfgScale: true,
        cfgRescale: true,
        sampler: true,
        noiseSchedule: true,
        resolution: true,
        variety: true
      })
    })
    return () => clearTimeout(timer)
  }, [meta])
  const toggle = (k: string): void => setSel((s) => ({ ...s, [k]: !s[k] }))

  const params = meta ? paramRows(meta, t) : []
  const hasCharacters = !!meta?.characterPrompts?.length
  // 이 이미지에 실제로 있는 항목만 — 개수 표시와 전체 선택/해제의 대상
  const available = meta
    ? ['prompt', 'negativePrompt', ...(hasCharacters ? ['characters'] : [])].concat(
        params.map((p) => p.k)
      )
    : []
  const selectedCount = available.filter((k) => sel[k]).length
  const allSelected = available.length > 0 && selectedCount === available.length
  const setAll = (value: boolean): void =>
    setSel((s) => ({ ...s, ...Object.fromEntries(available.map((k) => [k, value])) }))

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      {/* max-h + 내부 스크롤 — 작은 창에서 다이얼로그가 화면을 넘어 버튼이 가려지는 것 방지 */}
      <DialogContent className="flex max-h-[88vh] max-w-[900px] flex-col p-0">
        <div className="border-b border-line px-5 pb-3 pt-4 pr-12">
          <DialogTitle className="text-[15px] font-semibold">{t('ui.imageMetadata')}</DialogTitle>
          <DialogDescription className="mt-0.5 text-[12px] text-faint">
            {t('ui.onlyCheckedItemsAreApplied')}
          </DialogDescription>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-muted">
            <Loader2 size={18} className="animate-spin motion-reduce:animate-none" />{' '}
            {t('ui.reading')}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-16 text-danger-ink">
            <ImageOff size={30} strokeWidth={1.4} />
            <p className="text-[13px]">{error}</p>
          </div>
        ) : meta ? (
          <BottomFadeScroll className="flex gap-5 p-5">
            {/* 좌: 이미지(상) + 파라미터(하) */}
            <div className="flex w-[296px] shrink-0 flex-col gap-4">
              <Preview src={imageSrc} model={meta.model} />

              {params.length > 0 && (
                <section className="shrink-0">
                  <SectionTitle>{t('ui.parameters')}</SectionTitle>
                  <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface-2/30">
                    {params.map((p) => (
                      <ParamToggle
                        key={p.k}
                        label={p.label}
                        value={p.value!}
                        checked={!!sel[p.k]}
                        onToggle={() => toggle(p.k)}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>

            {/* 우: 프롬프트 */}
            <div className="flex min-w-0 flex-1 flex-col gap-4">
              {isSplitMeta(meta) ? (
                <SplitPreview meta={meta} sel={sel} toggle={toggle} />
              ) : (
                <PromptSection
                  label={t('ui.prompt')}
                  value={meta.prompt}
                  checked={!!sel.prompt}
                  onToggle={() => toggle('prompt')}
                  minHeight="min-h-28"
                />
              )}
              <PromptSection
                label={t('ui.negative')}
                value={meta.negativePrompt}
                checked={!!sel.negativePrompt}
                onToggle={() => toggle('negativePrompt')}
                minHeight="min-h-16"
              />
              {hasCharacters && (
                <section>
                  <SectionHeader
                    label={t('ui.characterPrompts')}
                    count={meta.characterPrompts!.length}
                    checked={!!sel.characters}
                    onToggle={() => toggle('characters')}
                  />
                  <div
                    className={cn('grid gap-2 transition-opacity', !sel.characters && 'opacity-45')}
                  >
                    {meta.characterPrompts!.map((c, i) => (
                      <CharacterCard
                        key={i}
                        index={i}
                        prompt={c.prompt}
                        negativePrompt={c.negativePrompt}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          </BottomFadeScroll>
        ) : null}

        {/* 스크롤 본문은 별도 합성 레이어라 클립 경계가 반올림되면 1px이 푸터 구분선 위로 그려진다 —
            푸터를 불투명 배경의 위 레이어로 올려 덮는다 */}
        <div className="relative z-10 flex items-center gap-2 border-t border-line bg-surface px-5 py-3">
          {meta && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setAll(!allSelected)}>
                {allSelected ? t('ui.deselectAll') : t('ui.selectAll')}
              </Button>
              <span className="text-[12px] tabular-nums text-faint" aria-live="polite">
                {t('ui.metadataSelectedCount', selectedCount, available.length)}
              </span>
            </>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={close}>
              {t('ui.close')}
            </Button>
            <Button
              variant="accent"
              disabled={!meta || selectedCount === 0}
              onClick={() => applyToMain(sel)}
            >
              {t('ui.applyToMain')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 본문 스크롤 영역 — 아래로 더 내용이 있으면 하단 가장자리를 페이드로 덮어 잘림을 알린다 */
function BottomFadeScroll({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 1)
    update()
    el.addEventListener('scroll', update, { passive: true })
    // 창 크기·내용(체크 토글, 언어 변경 등) 변화에도 다시 판정
    const ro = new ResizeObserver(update)
    ro.observe(el)
    for (const child of el.children) ro.observe(child)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [])
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* 패딩은 안쪽 래퍼에 — flex 스크롤러에 직접 주면 맨 아래 padding-bottom이 스크롤 범위에서 빠진다 */}
      <div ref={ref} className="min-h-0 flex-1 overflow-y-auto">
        <div className={className}>{children}</div>
      </div>
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface to-transparent transition-opacity motion-reduce:transition-none',
          more ? 'opacity-100' : 'opacity-0'
        )}
      />
    </div>
  )
}

/** 이미지 미리보기 — 비율이 달라 남는 여백은 같은 이미지를 흐리게 깔아 채운다 */
function Preview({ src, model }: { src: string | null; model?: string }): React.JSX.Element {
  return (
    <div className="relative isolate flex h-[min(300px,36vh)] shrink-0 items-center justify-center overflow-hidden rounded-xl border border-line bg-surface-2">
      {src ? (
        <>
          <img
            src={src}
            alt=""
            aria-hidden
            className="absolute inset-0 -z-10 size-full scale-125 object-cover opacity-60 blur-2xl"
          />
          <img src={src} alt="" className="max-h-full max-w-full object-contain drop-shadow-lg" />
        </>
      ) : (
        <ImageOff size={28} strokeWidth={1.3} className="text-faint" />
      )}
      {/* 모델은 표시만 (적용 대상 아님) */}
      {model && (
        <span
          title={model}
          className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)] truncate rounded-md bg-black/60 px-2 py-0.5 font-mono text-[11px] text-white backdrop-blur-sm"
        >
          {model}
        </span>
      )}
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h3 className="mb-1.5 px-0.5 text-[11.5px] font-semibold tracking-wide text-faint">
      {children}
    </h3>
  )
}

function CheckMark({ checked }: { checked: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-[5px] border transition-colors',
        checked ? 'border-accent bg-accent text-on-accent' : 'border-line bg-surface'
      )}
    >
      {checked && <Check size={11} strokeWidth={3} />}
    </span>
  )
}

/** 파라미터 한 줄 — 행 전체가 체크박스 */
function ParamToggle({
  label,
  value,
  checked,
  onToggle
}: {
  label: string
  value: string | number
  checked: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      className="group flex w-full items-center gap-2.5 px-3 py-2 text-left outline-none transition-colors hover:bg-surface-2/70 focus-visible:bg-surface-2/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
    >
      <CheckMark checked={checked} />
      <span
        className={cn(
          'flex-1 truncate text-[12px] transition-colors',
          checked ? 'text-muted' : 'text-faint'
        )}
      >
        {label}
      </span>
      <span
        title={String(value)}
        className={cn(
          'max-w-[60%] truncate font-mono text-[12px] transition-colors',
          checked ? 'text-ink' : 'text-faint line-through decoration-faint/60'
        )}
      >
        {value}
      </span>
    </button>
  )
}

/** 섹션 머리 — 체크 토글 라벨 + (선택) 복사 버튼 */
function SectionHeader({
  label,
  checked,
  onToggle,
  copyValue,
  count
}: {
  label: string
  checked: boolean
  onToggle: () => void
  copyValue?: string
  count?: number
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={onToggle}
        className="-mx-1 flex items-center gap-2 rounded-md px-1 py-0.5 text-[12.5px] font-semibold text-ink outline-none transition-colors hover:text-accent-ink focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <CheckMark checked={checked} />
        {label}
        {count != null && (
          <span className="rounded-full bg-surface-2 px-1.5 text-[11px] font-medium tabular-nums text-muted">
            {count}
          </span>
        )}
      </button>
      {copyValue !== undefined && <CopyButton value={copyValue} label={t('ui.copyValue', label)} />}
    </div>
  )
}

function PromptSection({
  label,
  value,
  checked,
  onToggle,
  minHeight
}: {
  label: string
  value: string
  checked: boolean
  onToggle: () => void
  minHeight: string
}): React.JSX.Element {
  return (
    <section>
      <SectionHeader label={label} checked={checked} onToggle={onToggle} copyValue={value} />
      <div
        className={cn(
          'rounded-xl border border-line bg-surface-2/30 px-3 py-2.5 transition-opacity',
          !checked && 'opacity-45'
        )}
      >
        <ReadonlyPrompt value={value} label={label} className={cn(minHeight, 'max-h-64')} />
      </div>
    </section>
  )
}

function SplitPreview({
  meta,
  sel,
  toggle
}: {
  meta: ImageMetadata
  sel: Selection
  toggle: (k: string) => void
}): React.JSX.Element {
  const t = useT()
  const parts = meta.promptParts
  const rows = [
    { label: t('ui.fixed'), value: parts?.base ?? '' },
    { label: t('ui.variable'), value: parts?.additional ?? '' },
    { label: t('ui.detail'), value: parts?.detail ?? '' }
  ]
  return (
    <section>
      <SectionHeader
        label={t('ui.value3PartPromptSplit')}
        checked={!!sel.prompt}
        onToggle={() => toggle('prompt')}
      />
      <div
        className={cn(
          'divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface-2/30 transition-opacity',
          !sel.prompt && 'opacity-45'
        )}
      >
        {rows.map((row) => (
          <div key={row.label} className="px-3 pb-2.5 pt-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-faint">{row.label}</span>
              <CopyButton value={row.value} label={t('ui.copyValue', row.label)} />
            </div>
            <ReadonlyPrompt value={row.value} label={row.label} className="min-h-6 max-h-48" />
          </div>
        ))}
      </div>
    </section>
  )
}

function CharacterCard({
  index,
  prompt,
  negativePrompt
}: {
  index: number
  prompt: string
  negativePrompt: string
}): React.JSX.Element {
  const t = useT()
  const name = t('ui.characterValue', index + 1)
  return (
    <div className="rounded-xl border border-line bg-surface-2/30 px-3 pb-2.5 pt-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span
          className={cn(
            'rounded-md px-1.5 py-px text-[11px] font-semibold',
            CHARACTER_TINTS[index % CHARACTER_TINTS.length]
          )}
        >
          {name}
        </span>
        <CopyButton value={prompt} label={t('ui.copyCharacterValuePrompt', index + 1)} />
      </div>
      <ReadonlyPrompt value={prompt} label={name} className="min-h-6 max-h-32 text-[12px]" />
      {negativePrompt && (
        <div className="mt-2 border-t border-dashed border-line pt-1.5">
          <div className="mb-0.5 flex items-center justify-between gap-2">
            <span className="font-mono text-[10.5px] font-medium uppercase text-faint">uc</span>
            <CopyButton
              value={negativePrompt}
              label={t('ui.copyCharacterValueNegative', index + 1)}
            />
          </div>
          <ReadonlyPrompt
            value={negativePrompt}
            label={`${name} uc`}
            className="min-h-5 max-h-24 text-[11.5px] text-muted"
          />
        </div>
      )}
    </div>
  )
}

// body의 user-select:none 때문에 <p>는 드래그 선택이 막힌다 — textarea여야 선택·스크롤 가능.
// field-sizing:content로 내용 높이에 맞춰 늘고 max-h를 넘으면 안에서 스크롤한다
function ReadonlyPrompt({
  value,
  label,
  className
}: {
  value: string
  label: string
  className?: string
}): React.JSX.Element {
  const t = useT()
  return (
    <textarea
      readOnly
      value={value}
      aria-label={label}
      placeholder={t('ui.none')}
      className={cn(
        'block w-full resize-none overflow-y-auto whitespace-pre-wrap break-words bg-transparent font-mono text-[12.5px] leading-relaxed text-ink outline-none [field-sizing:content] placeholder:font-sans placeholder:text-faint',
        'cursor-text select-text',
        className
      )}
    />
  )
}

function CopyButton({ value, label }: { value: string; label: string }): React.JSX.Element {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-md outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-35',
        copied ? 'text-success-ink' : 'text-faint hover:text-ink'
      )}
      title={label}
      aria-label={label}
      disabled={!value}
      onClick={() => {
        if (!value) return
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1400)
        })
      }}
    >
      {copied ? <Check size={13} strokeWidth={2.5} /> : <Copy size={13} />}
      <span className="sr-only" aria-live="polite">
        {copied ? t('ui.copiedToClipboard') : ''}
      </span>
    </button>
  )
}
