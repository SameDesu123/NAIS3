import { useState } from 'react'
import { Check, ChevronDown, Plus, Trash2 } from 'lucide-react'
import { RESOLUTIONS } from '../lib/constants'
import { useT } from '../lib/i18n'
import { useResolutionsStore, snapDim } from '../stores/resolutions-store'
import { toast } from '../stores/toast-store'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { cn } from '../lib/utils'

/**
 * 해상도 선택 — 기본 해상도(삭제 불가) + 커스텀 해상도(추가/삭제).
 * 커스텀은 64 배수로 스냅(생성 실패 방지). 가격/레이아웃은 width·height 기준이라 자동 대응.
 */
export function ResolutionPicker({
  width,
  height,
  onPick,
  disabled,
  className
}: {
  width: number
  height: number
  onPick: (width: number, height: number) => void
  disabled?: boolean
  className?: string
}): React.JSX.Element {
  const t = useT()
  const custom = useResolutionsStore((s) => s.custom)
  const add = useResolutionsStore((s) => s.add)
  const remove = useResolutionsStore((s) => s.remove)
  const [open, setOpen] = useState(false)
  const [w, setW] = useState('')
  const [h, setH] = useState('')

  const currentLabel =
    RESOLUTIONS.find((r) => r.width === width && r.height === height)?.label ??
    custom.find((r) => r.width === width && r.height === height)?.label ??
    `${width}×${height}`

  const isCurrent = (rw: number, rh: number): boolean => rw === width && rh === height

  const doAdd = (): void => {
    const nw = Number(w)
    const nh = Number(h)
    if (!nw || !nh) return
    const item = add(nw, nh)
    if (item) {
      onPick(item.width, item.height)
      setW('')
      setH('')
      if (item.width !== nw || item.height !== nh)
        toast(t('64 배수로 스냅됨 → {0}×{1}', item.width, item.height), 'info')
    } else {
      toast(t('이미 있는 해상도입니다'), 'info')
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          disabled={disabled}
          className={cn(
            'flex h-8 items-center gap-1.5 rounded-md border border-line bg-paper px-2.5 text-[13px] disabled:opacity-50',
            className
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">{t(currentLabel)}</span>
          <ChevronDown size={14} className="shrink-0 text-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-1">
        <div className="max-h-72 overflow-y-auto">
          {RESOLUTIONS.map((r) => (
            <button
              key={r.label}
              onClick={() => {
                onPick(r.width, r.height)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-2',
                isCurrent(r.width, r.height) && 'font-semibold text-accent'
              )}
            >
              <span className="min-w-0 flex-1 truncate">{t(r.label)}</span>
              {isCurrent(r.width, r.height) && <Check size={12} className="shrink-0" />}
            </button>
          ))}

          {custom.length > 0 && <div className="my-1 h-px bg-line" />}
          {custom.map((r, i) => (
            <div key={`${r.width}x${r.height}`} className="group flex items-center gap-1">
              <button
                onClick={() => {
                  onPick(r.width, r.height)
                  setOpen(false)
                }}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-2',
                  isCurrent(r.width, r.height) && 'font-semibold text-accent'
                )}
              >
                <span className="min-w-0 flex-1 truncate">{t(r.label)}</span>
                {isCurrent(r.width, r.height) && <Check size={12} className="shrink-0" />}
              </button>
              <button
                title={t('삭제')}
                onClick={() => remove(i)}
                className="grid size-6 shrink-0 place-items-center rounded text-faint opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>

        {/* 커스텀 추가 — 64 배수로 스냅됨 */}
        <div className="mt-1 flex items-center gap-1 border-t border-line pt-1.5">
          <input
            value={w}
            onChange={(e) => setW(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder={t('가로')}
            inputMode="numeric"
            className="h-7 w-0 flex-1 rounded border border-line bg-paper px-1.5 text-center text-[12px] outline-none focus:border-accent/50"
          />
          <span className="text-[11px] text-faint">×</span>
          <input
            value={h}
            onChange={(e) => setH(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder={t('세로')}
            inputMode="numeric"
            onKeyDown={(e) => e.key === 'Enter' && doAdd()}
            className="h-7 w-0 flex-1 rounded border border-line bg-paper px-1.5 text-center text-[12px] outline-none focus:border-accent/50"
          />
          <button
            title={
              w && h
                ? t('추가 (64 배수 스냅: {0}×{1})', snapDim(Number(w)), snapDim(Number(h)))
                : t('추가')
            }
            onClick={doAdd}
            className="grid size-7 shrink-0 place-items-center rounded bg-accent text-paper hover:opacity-90"
          >
            <Plus size={14} />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
