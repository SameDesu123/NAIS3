import { Download, Grid2x2, Palette, Scaling, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../lib/i18n'
import { cn } from '../lib/utils'
import {
  PIXELATE_COLOR_STEPS,
  PIXELATE_DOT_MAX,
  PIXELATE_DOT_MIN,
  pixelate,
  pixelateSmall,
  type PixelBuffer
} from '../lib/pixelate'
import { toast } from '../stores/toast-store'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { Slider } from './ui/slider'
import { Switch } from './ui/switch'

/**
 * 도트화 편집기 (디렉터 로컬 툴): 이미지 전체를 픽셀 아트로 변환.
 * 레이아웃은 캐릭터 배치 편집기와 같다 (왼쪽 점 격자 작업대 + 오른쪽 옵션 사이드바).
 * 미리보기는 도트 1개 = 1픽셀인 작은 결과를 캔버스에 그리고 CSS(pixelated)로만 키운다
 * — 슬라이더를 움직일 때마다 원본 해상도로 확대하지 않아 가볍다.
 */
export function PixelateEditor({
  imageBase64,
  width,
  height,
  onConfirm,
  onCancel
}: {
  imageBase64: string
  width: number
  height: number
  onConfirm: (resultBase64: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [original, setOriginal] = useState<PixelBuffer | null>(null)
  const [dot, setDot] = useState(8)
  // 0 = 색 수 제한 없음
  const [colors, setColors] = useState<number>(16)
  const [dither, setDither] = useState(false)
  const [keepSize, setKeepSize] = useState(true)

  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      const off = document.createElement('canvas')
      off.width = width
      off.height = height
      const ctx = off.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, 0, 0, width, height)
      const { data } = ctx.getImageData(0, 0, width, height)
      setOriginal({ data, width, height })
    }
    img.src = `data:image/png;base64,${imageBase64}`
  }, [imageBase64, width, height])

  useEffect(() => {
    void window.nais.invoke('settings:get', { key: 'pixelate_dot' }).then(({ value }) => {
      if (value) setDot(Math.min(PIXELATE_DOT_MAX, Math.max(PIXELATE_DOT_MIN, Number(value))))
    })
    void window.nais.invoke('settings:get', { key: 'pixelate_colors' }).then(({ value }) => {
      // 예전 슬라이더 값(임의 색 수·0=제한 없음)은 가장 가까운 단계로 맞춘다
      if (value) setColors(nearestColorStep(Number(value)))
    })
    void window.nais.invoke('settings:get', { key: 'pixelate_dither' }).then(({ value }) => {
      if (value) setDither(value === '1')
    })
    void window.nais.invoke('settings:get', { key: 'pixelate_keep_size' }).then(({ value }) => {
      if (value) setKeepSize(value === '1')
    })
  }, [])
  function persist(key: string, value: string): void {
    void window.nais.invoke('settings:set', { key, value })
  }

  const preview = useMemo(
    () => (original ? pixelateSmall(original, { dot, colors, dither }) : null),
    [original, dot, colors, dither]
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !preview) return
    canvas.width = preview.width
    canvas.height = preview.height
    canvas
      .getContext('2d')!
      .putImageData(new ImageData(preview.data, preview.width, preview.height), 0, 0)
  }, [preview])

  function exportResult(): string | null {
    if (!original) return null
    const out = pixelate(original, { dot, colors, dither, keepSize })
    const canvas = document.createElement('canvas')
    canvas.width = out.width
    canvas.height = out.height
    canvas.getContext('2d')!.putImageData(new ImageData(out.data, out.width, out.height), 0, 0)
    return canvas.toDataURL('image/png').split(',')[1]
  }

  const outW = keepSize ? width : Math.ceil(width / dot)
  const outH = keepSize ? height : Math.ceil(height / dot)

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="flex h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-[1400px] flex-col gap-2 bg-surface-2 p-2 md:flex-row">
        {/* 좌측: 미리보기만 — 캐릭터 배치 편집기와 같은 점 격자 작업대 */}
        <div
          className="flex min-h-0 min-w-0 flex-1 rounded-xl border border-line bg-surface p-6 shadow-sm"
          style={{
            backgroundImage: 'radial-gradient(var(--color-line) 1px, transparent 1.5px)',
            backgroundSize: '18px 18px',
            backgroundPosition: 'center'
          }}
        >
          <div
            className="flex min-h-0 min-w-0 flex-1 items-center justify-center"
            style={{ containerType: 'size' }}
          >
            <div
              className="relative shrink-0 overflow-hidden rounded-md border border-line bg-paper shadow-xl shadow-black/25"
              style={{
                width: `min(100%, calc(100cqh * ${Math.max(1, width) / Math.max(1, height)}))`,
                aspectRatio: `${Math.max(1, width)} / ${Math.max(1, height)}`
              }}
            >
              <canvas
                ref={canvasRef}
                className="absolute inset-0 h-full w-full"
                style={{ imageRendering: 'pixelated' }}
              />
            </div>
          </div>
        </div>

        {/* 우측: 제목·옵션·실행 버튼을 모은 사이드바 */}
        <aside className="flex max-h-[40%] w-full shrink-0 flex-col gap-4 overflow-y-auto p-2 md:max-h-none md:w-64">
          <div className="pr-8">
            <DialogTitle className="flex items-center gap-2">
              <Grid2x2 size={15} /> {t('ui.pixelArt')}
            </DialogTitle>
            <DialogDescription className="mt-1.5 leading-relaxed">
              {t('ui.pixelArtInstructions')}
            </DialogDescription>
          </div>

          <section className="flex flex-col gap-0.5">
            <SidebarLabel icon={Grid2x2} value={`${dot}px`}>
              {t('ui.pixelArtDotSize')}
            </SidebarLabel>
            {/* 트랙 색이 사이드바 배경과 같아서 카드 위에 올려 빈 구간도 보이게 */}
            <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
              <Slider
                aria-label={t('ui.pixelArtDotSize')}
                min={PIXELATE_DOT_MIN}
                max={PIXELATE_DOT_MAX}
                step={1}
                value={[dot]}
                onValueChange={([v]) => {
                  setDot(v)
                  persist('pixelate_dot', String(v))
                }}
              />
            </div>
          </section>

          <section className="flex flex-col gap-0.5">
            <SidebarLabel icon={Palette} value={String(colors)}>
              {t('ui.pixelArtColorCount')}
            </SidebarLabel>
            <div
              role="group"
              aria-label={t('ui.pixelArtColorCount')}
              className="grid grid-cols-4 gap-0.5 rounded-lg border border-line bg-surface p-0.5"
            >
              {PIXELATE_COLOR_STEPS.map((step) => (
                <button
                  key={step}
                  type="button"
                  aria-pressed={colors === step}
                  className={cn(
                    'h-7 rounded-md font-mono text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40',
                    colors === step
                      ? 'bg-accent-soft font-medium text-accent-ink'
                      : 'text-muted hover:bg-surface-2 hover:text-ink'
                  )}
                  onClick={() => {
                    setColors(step)
                    persist('pixelate_colors', String(step))
                  }}
                >
                  {step}
                </button>
              ))}
            </div>
            <label
              className="mt-1 flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[12.5px] transition-colors hover:bg-surface/60"
              title={t('ui.pixelArtDitherDescription')}
            >
              <span className="min-w-0 flex-1 truncate">{t('ui.pixelArtDither')}</span>
              <Switch
                checked={dither}
                onCheckedChange={(on) => {
                  setDither(on)
                  persist('pixelate_dither', on ? '1' : '0')
                }}
              />
            </label>
          </section>

          <section className="flex flex-col gap-0.5">
            <SidebarLabel icon={Scaling}>{t('ui.pixelArtOutput')}</SidebarLabel>
            <label className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[12.5px] transition-colors hover:bg-surface/60">
              <span className="min-w-0 flex-1 truncate">{t('ui.pixelArtKeepSize')}</span>
              <Switch
                checked={keepSize}
                onCheckedChange={(on) => {
                  setKeepSize(on)
                  persist('pixelate_keep_size', on ? '1' : '0')
                }}
              />
            </label>
            <div className="flex h-8 items-center gap-2 px-2.5 text-[12.5px]">
              <span className="min-w-0 flex-1 truncate text-muted">
                {t('ui.pixelArtOutputSize')}
              </span>
              <span className="shrink-0 font-mono text-[10.5px] text-faint">
                {outW}×{outH}
              </span>
            </div>
          </section>

          <div className="flex-1" />
          <div className="flex shrink-0 flex-col gap-1.5">
            <Button
              variant="accent"
              className="w-full"
              disabled={!original}
              onClick={() => {
                const base64 = exportResult()
                if (base64) onConfirm(base64)
              }}
            >
              {t('ui.apply')}
            </Button>
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                variant="ghost"
                className="gap-1"
                disabled={!original}
                title={t('ui.pixelArtSaveToFile')}
                onClick={() => {
                  const base64 = exportResult()
                  if (!base64) return
                  void window.nais
                    .invoke('images:saveBase64As', {
                      base64,
                      defaultName: `pixel_${outW}x${outH}.png`
                    })
                    .then(({ saved }) => saved && toast(t('ui.saved'), 'success'))
                }}
              >
                <Download size={13} /> {t('ui.download')}
              </Button>
              <Button variant="ghost" onClick={onCancel}>
                {t('ui.cancel')}
              </Button>
            </div>
          </div>
        </aside>
      </DialogContent>
    </Dialog>
  )
}

/** 사이드바 섹션 제목 — 캐릭터 배치 편집기와 같은 모양, 오른쪽에 현재 값 */
function SidebarLabel({
  icon: Icon,
  value,
  children
}: {
  icon: LucideIcon
  value?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-1 flex items-center gap-1.5 px-2.5 text-[11px] font-medium text-faint">
      <Icon size={12} />
      <span className="flex-1">{children}</span>
      {value != null && <span className="font-mono text-[10.5px] text-muted">{value}</span>}
    </div>
  )
}

function nearestColorStep(value: number): number {
  return PIXELATE_COLOR_STEPS.reduce((best, step) =>
    Math.abs(step - value) < Math.abs(best - value) ? step : best
  )
}
