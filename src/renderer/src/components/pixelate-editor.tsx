import { Gamepad2, Grid2x2, Palette, Scaling } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { useT } from '../lib/i18n'
import { imageDataToBase64, useImageData } from '../lib/image-data'
import {
  PIXELATE_COLOR_STEPS,
  PIXELATE_DOT_MAX,
  PIXELATE_DOT_MIN,
  pixelate,
  pixelateSmall
} from '../lib/pixelate'
import { boolSetting, intSetting, useStoredSetting, type SettingCodec } from '../lib/stored-setting'
import { cn } from '../lib/utils'
import {
  ToolPage,
  ToolPageActions,
  ToolPageInfo,
  ToolPageSection,
  ToolPageSliderRow,
  ToolPageStage,
  ToolPageToggle,
  type LocalEditorProps
} from './tool-page'
import { Slider } from './ui/slider'

const DOT_SETTING = intSetting(PIXELATE_DOT_MIN, PIXELATE_DOT_MAX)
// 예전 슬라이더 값(임의 색 수·0=제한 없음)은 가장 가까운 단계로 맞춘다
const COLORS_SETTING: SettingCodec<number> = {
  parse: (raw) => nearestColorStep(Number(raw)),
  format: String
}

/**
 * 도트화 편집 페이지 (디렉터 로컬 툴): 이미지 전체를 픽셀 아트로 변환.
 * 미리보기는 도트 1개 = 1픽셀인 작은 결과를 캔버스에 그리고 CSS(pixelated)로만 키운다
 * — 슬라이더를 움직일 때마다 원본 해상도로 확대하지 않아 가볍다.
 */
export function PixelateEditorPage({
  ready,
  imageBase64,
  width,
  height,
  onConfirm,
  onCancel
}: LocalEditorProps): React.JSX.Element {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const original = useImageData(imageBase64, width, height, ready)
  const [dot, setDot] = useStoredSetting('pixelate_dot', 8, DOT_SETTING)
  const [colors, setColors] = useStoredSetting('pixelate_colors', 16, COLORS_SETTING)
  const [dither, setDither] = useStoredSetting('pixelate_dither', false, boolSetting)
  const [keepSize, setKeepSize] = useStoredSetting('pixelate_keep_size', true, boolSetting)

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
    return imageDataToBase64(new ImageData(out.data, out.width, out.height))
  }

  const outW = keepSize ? width : Math.ceil(width / dot)
  const outH = keepSize ? height : Math.ceil(height / dot)

  return (
    <ToolPage
      icon={Gamepad2}
      title={t('ui.pixelArt')}
      description={t('ui.pixelArtInstructions')}
      onBack={onCancel}
      stage={
        <ToolPageStage width={width} height={height}>
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={t('ui.pixelArtPreview')}
            className="absolute inset-0 h-full w-full"
            style={{ imageRendering: 'pixelated' }}
          />
        </ToolPageStage>
      }
      footer={
        <ToolPageActions
          disabled={!original}
          exportResult={exportResult}
          fileName={`pixel_${outW}x${outH}.png`}
          downloadTitle={t('ui.pixelArtSaveToFile')}
          onApply={onConfirm}
          onCancel={onCancel}
        />
      }
    >
      <ToolPageSection icon={Grid2x2} label={t('ui.pixelArtDotSize')} value={`${dot}px`}>
        <ToolPageSliderRow>
          <Slider
            aria-label={t('ui.pixelArtDotSize')}
            min={PIXELATE_DOT_MIN}
            max={PIXELATE_DOT_MAX}
            step={1}
            value={[dot]}
            onValueChange={([v]) => setDot(v)}
          />
        </ToolPageSliderRow>
      </ToolPageSection>

      <ToolPageSection icon={Palette} label={t('ui.pixelArtColorCount')} value={String(colors)}>
        <div
          role="group"
          aria-label={t('ui.pixelArtColorCount')}
          className="grid grid-cols-4 gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5"
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
                  : 'text-muted hover:bg-surface hover:text-ink'
              )}
              onClick={() => setColors(step)}
            >
              {step}
            </button>
          ))}
        </div>
        <div className="mt-1">
          <ToolPageToggle
            label={t('ui.pixelArtDither')}
            title={t('ui.pixelArtDitherDescription')}
            checked={dither}
            onCheckedChange={setDither}
          />
        </div>
      </ToolPageSection>

      <ToolPageSection icon={Scaling} label={t('ui.pixelArtOutput')}>
        <ToolPageToggle
          label={t('ui.pixelArtKeepSize')}
          checked={keepSize}
          onCheckedChange={setKeepSize}
        />
        <ToolPageInfo label={t('ui.pixelArtOutputSize')} value={`${outW}×${outH}`} />
      </ToolPageSection>
    </ToolPage>
  )
}

function nearestColorStep(value: number): number {
  return PIXELATE_COLOR_STEPS.reduce((best, step) =>
    Math.abs(step - value) < Math.abs(best - value) ? step : best
  )
}
