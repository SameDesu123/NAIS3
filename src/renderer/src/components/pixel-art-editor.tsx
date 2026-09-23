import { Download, Loader2, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RgbColor } from '../lib/pixelation'
import {
  buildGradientPalette,
  colorToHex,
  extractAutomaticPalette,
  parsePaletteText,
  quantizePixels
} from '../lib/pixelation'
import { useT } from '../lib/i18n'
import { toast } from '../stores/toast-store'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { Textarea } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Slider } from './ui/slider'

type PaletteMode = 'automatic' | 'custom' | 'gradient'
type PaletteCount = 8 | 16 | 64 | 256

interface PreviewResult {
  url: string
  palette: RgbColor[]
  reducedWidth: number
  reducedHeight: number
}

const COUNTS: PaletteCount[] = [8, 16, 64, 256]
const DEFAULT_COLORS = '#17152b #356ca3 #ef6f6c #f4d35e #f7f3e8'

function paletteFor(
  mode: PaletteMode,
  count: PaletteCount,
  text: string,
  pixels: Uint8ClampedArray
): RgbColor[] {
  const selected = parsePaletteText(text)
  if (mode === 'automatic') return extractAutomaticPalette(pixels, count)
  if (mode === 'gradient') return buildGradientPalette(selected, count)
  return selected.length > 0 ? selected : [{ r: 0, g: 0, b: 0 }]
}

function drawReduced(
  image: HTMLImageElement,
  width: number,
  height: number,
  palette: readonly RgbColor[] | null,
  mode: PaletteMode,
  count: PaletteCount,
  text: string
): { canvas: HTMLCanvasElement; palette: RgbColor[] } {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
  const resolvedPalette = palette ? [...palette] : paletteFor(mode, count, text, imageData.data)
  imageData.data.set(quantizePixels(imageData.data, resolvedPalette))
  context.putImageData(imageData, 0, 0)
  return { canvas, palette: resolvedPalette }
}

export function PixelArtEditor({
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
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [imageReady, setImageReady] = useState(false)
  const [pixelSize, setPixelSize] = useState(8)
  const [mode, setMode] = useState<PaletteMode>('automatic')
  const [colorCount, setColorCount] = useState<PaletteCount>(16)
  const [paletteText, setPaletteText] = useState(DEFAULT_COLORS)
  const [newColor, setNewColor] = useState('#7c5cff')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewing, setPreviewing] = useState(true)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    const image = new Image()
    image.onload = () => {
      imageRef.current = image
      setImageReady(true)
    }
    image.src = `data:image/png;base64,${imageBase64}`
    return () => {
      imageRef.current = null
    }
  }, [imageBase64])

  useEffect(() => {
    void Promise.all([
      window.nais.invoke('settings:get', { key: 'pixel_art_size' }),
      window.nais.invoke('settings:get', { key: 'pixel_art_palette_mode' }),
      window.nais.invoke('settings:get', { key: 'pixel_art_color_count' }),
      window.nais.invoke('settings:get', { key: 'pixel_art_palette' })
    ]).then(([size, storedMode, count, colors]) => {
      const parsedSize = Number(size.value)
      if (Number.isFinite(parsedSize)) setPixelSize(Math.max(1, Math.min(32, parsedSize)))
      if (
        storedMode.value === 'automatic' ||
        storedMode.value === 'custom' ||
        storedMode.value === 'gradient'
      )
        setMode(storedMode.value)
      const parsedCount = Number(count.value)
      if (COUNTS.includes(parsedCount as PaletteCount)) setColorCount(parsedCount as PaletteCount)
      if (colors.value) setPaletteText(colors.value)
    })
  }, [])

  useEffect(() => {
    if (!imageReady || !imageRef.current) return
    setPreviewing(true)
    let cancelled = false
    const timer = window.setTimeout(() => {
      const scale = Math.min(1, 660 / width, 620 / height)
      const previewWidth = Math.max(1, Math.round(width * scale))
      const previewHeight = Math.max(1, Math.round(height * scale))
      const previewPixelSize = Math.max(1, pixelSize * scale)
      const reducedWidth = Math.max(1, Math.ceil(previewWidth / previewPixelSize))
      const reducedHeight = Math.max(1, Math.ceil(previewHeight / previewPixelSize))
      const rendered = drawReduced(
        imageRef.current!,
        reducedWidth,
        reducedHeight,
        null,
        mode,
        colorCount,
        paletteText
      )
      if (!cancelled) {
        setPreview({
          url: rendered.canvas.toDataURL('image/png'),
          palette: rendered.palette,
          reducedWidth,
          reducedHeight
        })
        setPreviewing(false)
      }
    }, 80)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [colorCount, height, imageReady, mode, paletteText, pixelSize, width])

  const selectedColors = useMemo(() => parsePaletteText(paletteText), [paletteText])
  const customPaletteMissing = mode === 'custom' && selectedColors.length === 0

  function persist(key: string, value: string | number): void {
    void window.nais.invoke('settings:set', { key, value: String(value) })
  }

  async function createResult(): Promise<string | null> {
    const image = imageRef.current
    if (!image || !preview || customPaletteMissing) return null
    setExporting(true)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    try {
      const reducedWidth = Math.max(1, Math.ceil(width / pixelSize))
      const reducedHeight = Math.max(1, Math.ceil(height / pixelSize))
      const { canvas } = drawReduced(
        image,
        reducedWidth,
        reducedHeight,
        preview.palette,
        mode,
        colorCount,
        paletteText
      )
      const output = document.createElement('canvas')
      output.width = width
      output.height = height
      const context = output.getContext('2d')!
      context.imageSmoothingEnabled = false
      context.drawImage(canvas, 0, 0, width, height)
      return output.toDataURL('image/png').split(',')[1]
    } finally {
      setExporting(false)
    }
  }

  async function downloadResult(): Promise<void> {
    const base64 = await createResult()
    if (!base64) return
    const { saved } = await window.nais.invoke('images:saveBase64As', {
      base64,
      defaultName: `pixel-art_${width}x${height}.png`
    })
    if (saved) toast(t('ui.saved'), 'success')
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] max-w-[1040px] flex-col p-0">
        <div className="border-b border-line px-5 py-4 pr-12">
          <DialogTitle>{t('ui.pixelArtEditor')}</DialogTitle>
          <DialogDescription className="mt-1">
            {t('ui.pixelArtEditorDescription')}
          </DialogDescription>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_310px] max-[760px]:grid-cols-1">
          <div className="relative flex min-h-[360px] items-center justify-center overflow-hidden bg-paper p-4">
            {preview && (
              <img
                src={preview.url}
                className="max-h-[min(620px,calc(100vh-12rem))] max-w-full rounded-md border border-line object-contain"
                style={{ imageRendering: 'pixelated' }}
                draggable={false}
                alt=""
              />
            )}
            {(previewing || exporting) && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-paper/55 text-[12px] text-muted backdrop-blur-[1px]">
                <Loader2 size={17} className="animate-spin text-accent" />
                {exporting ? t('ui.renderingFullResolution') : t('ui.updatingPreview')}
              </div>
            )}
            {preview && !previewing && (
              <span className="absolute bottom-5 left-5 rounded-md bg-black/55 px-2 py-1 font-mono text-[10px] text-white backdrop-blur">
                {preview.reducedWidth}×{preview.reducedHeight} → {width}×{height}
              </span>
            )}
          </div>

          <div className="min-h-0 overflow-y-auto border-l border-line p-4 max-[760px]:border-l-0 max-[760px]:border-t">
            <div className="space-y-5">
              <section>
                <div className="mb-2 flex items-center justify-between text-[12px]">
                  <span className="font-medium text-ink">{t('ui.pixelSize')}</span>
                  <span className="font-mono text-muted">{pixelSize}px</span>
                </div>
                <Slider
                  min={1}
                  max={32}
                  step={1}
                  value={[pixelSize]}
                  onValueChange={([value]) => {
                    setPixelSize(value)
                    persist('pixel_art_size', value)
                  }}
                />
                <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
                  {t('ui.pixelSizeDescription')}
                </p>
              </section>

              <section>
                <label className="mb-2 block text-[12px] font-medium text-ink">
                  {t('ui.paletteMode')}
                </label>
                <Select
                  value={mode}
                  onValueChange={(value: PaletteMode) => {
                    setMode(value)
                    persist('pixel_art_palette_mode', value)
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="automatic">{t('ui.automaticPalette')}</SelectItem>
                    <SelectItem value="custom">{t('ui.customPalette')}</SelectItem>
                    <SelectItem value="gradient">{t('ui.gradientPalette')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
                  {mode === 'automatic'
                    ? t('ui.automaticPaletteDescription')
                    : mode === 'custom'
                      ? t('ui.customPaletteDescription')
                      : t('ui.gradientPaletteDescription')}
                </p>
              </section>

              {mode !== 'custom' && (
                <section>
                  <span className="mb-2 block text-[12px] font-medium text-ink">
                    {t('ui.colorCount')}
                  </span>
                  <div className="grid grid-cols-4 gap-1.5">
                    {COUNTS.map((count) => (
                      <Button
                        key={count}
                        size="sm"
                        variant={colorCount === count ? 'accent' : 'ghost'}
                        className="px-1 font-mono"
                        onClick={() => {
                          setColorCount(count)
                          persist('pixel_art_color_count', count)
                        }}
                      >
                        {count}
                      </Button>
                    ))}
                  </div>
                </section>
              )}

              {mode !== 'automatic' && (
                <section>
                  <label className="mb-2 block text-[12px] font-medium text-ink">
                    {mode === 'custom' ? t('ui.paletteColors') : t('ui.gradientAnchorColors')}
                  </label>
                  <Textarea
                    className="h-20 resize-none font-mono text-[11px]"
                    value={paletteText}
                    spellCheck={false}
                    placeholder="#17152b #356ca3 #f7f3e8"
                    onChange={(event) => {
                      setPaletteText(event.target.value)
                      persist('pixel_art_palette', event.target.value)
                    }}
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      type="color"
                      value={newColor}
                      aria-label={t('ui.chooseColor')}
                      className="h-8 w-10 cursor-pointer rounded border border-line bg-paper p-1"
                      onChange={(event) => setNewColor(event.target.value)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1"
                      onClick={() => {
                        const value = `${paletteText.trim()} ${newColor}`.trim()
                        setPaletteText(value)
                        persist('pixel_art_palette', value)
                      }}
                    >
                      <Plus size={13} /> {t('ui.addColor')}
                    </Button>
                    <span className="ml-auto text-[10px] text-faint">
                      {t('ui.valueColors', selectedColors.length)}
                    </span>
                  </div>
                  {customPaletteMissing && (
                    <p className="mt-2 text-[11px] text-danger">
                      {t('ui.addAtLeastOnePaletteColor')}
                    </p>
                  )}
                </section>
              )}

              <section>
                <span className="mb-2 block text-[12px] font-medium text-ink">
                  {t('ui.resultPalette')}
                </span>
                <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto rounded-md border border-line bg-paper p-2">
                  {(preview?.palette ?? []).map((color, index) => (
                    <span
                      key={`${colorToHex(color)}-${index}`}
                      className="size-4 rounded-sm border border-black/15"
                      style={{ backgroundColor: colorToHex(color) }}
                      title={colorToHex(color)}
                    />
                  ))}
                </div>
              </section>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          <span className="text-[11px] text-faint">{t('ui.localProcessingNoAnlas')}</span>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            className="gap-1"
            disabled={!preview || previewing || exporting || customPaletteMissing}
            title={t('ui.savePixelArtResultToAFile')}
            onClick={() => void downloadResult()}
          >
            <Download size={13} /> {t('ui.download')}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={exporting}>
            {t('ui.cancel')}
          </Button>
          <Button
            variant="accent"
            disabled={!preview || previewing || exporting || customPaletteMissing}
            onClick={() => {
              void createResult().then((base64) => base64 && onConfirm(base64))
            }}
          >
            {t('ui.apply')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
