import { Gamepad2, Grid2x2, Loader2, Palette, Scaling } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useT } from '../lib/i18n'
import { imageDataToBase64 } from '../lib/image-data'
import {
  PIXELATE_COLOR_STEPS,
  PIXELATE_DOT_MAX,
  PIXELATE_DOT_MIN,
  upscaleNearest
} from '../lib/pixelate'
import { usePixelatePreview } from '../lib/pixelate-preview'
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
 * 미리보기는 도트 1개 = 1픽셀인 작은 결과(원본 해독부터 워커에서 계산)를 캔버스에 그리고 CSS(pixelated)로만 키운다
 * — 슬라이더를 움직일 때마다 원본 해상도로 확대하지 않아 가볍다. 저장은 그 결과를 그대로 키워 쓴다.
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
  const [dot, setDot] = useStoredSetting('pixelate_dot', 8, DOT_SETTING)
  const [colors, setColors] = useStoredSetting('pixelate_colors', 16, COLORS_SETTING)
  const [dither, setDither] = useStoredSetting('pixelate_dither', false, boolSetting)
  const [keepSize, setKeepSize] = useStoredSetting('pixelate_keep_size', true, boolSetting)

  const { preview, fresh } = usePixelatePreview(imageBase64, width, height, ready, {
    dot,
    colors,
    dither
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !preview) return
    const { small } = preview
    canvas.width = small.width
    canvas.height = small.height
    canvas
      .getContext('2d')!
      .putImageData(new ImageData(small.data, small.width, small.height), 0, 0)
  }, [preview])

  /** 미리보기 결과를 그대로 저장 — 다시 계산하지 않는다 (옵션을 바꾼 뒤 계산이 끝나기 전엔 null) */
  function exportResult(): string | null {
    if (!preview || !fresh) return null
    const { small } = preview
    const out = keepSize ? upscaleNearest(small, dot, width, height) : small
    return imageDataToBase64(new ImageData(out.data, out.width, out.height))
  }

  const outW = keepSize ? width : Math.ceil(width / dot)
  const outH = keepSize ? height : Math.ceil(height / dot)
  // 원본 크기 유지는 가장자리 칸이 잘린 채 저장된다 (65px·도트 32 → 32·32·1).
  // 미리보기도 칸을 도트 크기 그대로 깔고 원본 크기 밖은 잘라 저장 결과와 같은 배치로 보여 준다
  const covered =
    preview && keepSize
      ? {
          width: `${((preview.small.width * preview.opts.dot) / Math.max(1, width)) * 100}%`,
          height: `${((preview.small.height * preview.opts.dot) / Math.max(1, height)) * 100}%`
        }
      : { width: '100%', height: '100%' }

  return (
    <ToolPage
      icon={Gamepad2}
      title={t('ui.pixelArt')}
      description={t('ui.pixelArtInstructions')}
      onBack={onCancel}
      stage={
        <ToolPageStage width={keepSize ? width : outW} height={keepSize ? height : outH}>
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={t('ui.pixelArtPreview')}
            className="absolute left-0 top-0"
            style={{ ...covered, imageRendering: 'pixelated' }}
          />
          {ready && !fresh && (
            <div
              role="status"
              aria-label={t('ui.pixelArtComputing')}
              // 멀리서도 보이게 작업대 한가운데에 크게
              className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 whitespace-nowrap rounded-lg bg-black/60 px-4 py-2.5 text-[15px] font-medium text-white shadow-lg"
            >
              <Loader2 size={20} className="animate-spin" />
              {t('ui.pixelArtComputing')}
            </div>
          )}
        </ToolPageStage>
      }
      footer={
        <ToolPageActions
          disabled={!fresh}
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
