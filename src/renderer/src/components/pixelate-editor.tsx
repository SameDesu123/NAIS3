import { Gamepad2, Grid2x2, Loader2, Palette, Scaling, SwatchBook } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { useT } from '../lib/i18n'
import { imageDataToBase64 } from '../lib/image-data'
import {
  customToneRamp,
  PIXELATE_COLOR_STEPS,
  PIXELATE_DOT_MAX,
  PIXELATE_DOT_MIN,
  PIXELATE_TONE_PRESETS,
  upscaleNearest,
  type PixelateTonePreset
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

type ToneChoice = 'none' | PixelateTonePreset | 'custom'
const TONE_CHOICES: ToneChoice[] = [
  'none',
  ...(Object.keys(PIXELATE_TONE_PRESETS) as PixelateTonePreset[]),
  'custom'
]
const TONE_SETTING: SettingCodec<ToneChoice> = {
  parse: (raw) => (TONE_CHOICES.includes(raw as ToneChoice) ? (raw as ToneChoice) : null),
  format: String
}
const TONE_COLOR_SETTING: SettingCodec<string> = {
  parse: (raw) => (/^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : null),
  format: String
}
const TONE_STRENGTH_SETTING = intSetting(0, 100)
// 원본 버튼의 띠 — 색을 바꾸지 않는다는 뜻으로 여러 색을 그대로 늘어놓는다
const ORIGINAL_SWATCH = 'linear-gradient(90deg, #e5484d, #f5a524, #46a758, #3e7bfa, #8e4ec6)'

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
  const [toneChoice, setToneChoice] = useStoredSetting('pixelate_tone', 'none', TONE_SETTING)
  const [toneColor, setToneColor] = useStoredSetting(
    'pixelate_tone_color',
    '#d0488f',
    TONE_COLOR_SETTING
  )
  const [toneStrength, setToneStrength] = useStoredSetting(
    'pixelate_tone_strength',
    100,
    TONE_STRENGTH_SETTING
  )

  const tone = useMemo(() => {
    if (toneChoice === 'none' || toneStrength === 0) return null
    const ramp =
      toneChoice === 'custom' ? customToneRamp(toneColor) : PIXELATE_TONE_PRESETS[toneChoice]
    return { ramp, strength: toneStrength / 100 }
  }, [toneChoice, toneColor, toneStrength])

  const { preview, fresh, failed } = usePixelatePreview(imageBase64, width, height, ready, {
    dot,
    colors,
    dither,
    tone
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
          {ready && failed && (
            <div
              role="alert"
              className="absolute left-1/2 top-1/2 max-w-[80%] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-black/60 px-4 py-2.5 text-center text-[15px] font-medium text-white shadow-lg"
            >
              {t('ui.pixelArtFailed')}
            </div>
          )}
          {ready && !fresh && !failed && (
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

      <ToolPageSection
        icon={SwatchBook}
        label={t('ui.pixelArtTone')}
        value={toneChoice === 'none' ? undefined : `${toneStrength}%`}
      >
        <div
          role="group"
          aria-label={t('ui.pixelArtTone')}
          className="grid grid-cols-2 gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5"
        >
          {TONE_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={toneChoice === choice}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-md px-2 pb-1.5 pt-2 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40',
                toneChoice === choice
                  ? 'bg-accent-soft font-medium text-accent-ink'
                  : 'text-muted hover:bg-surface hover:text-ink'
              )}
              onClick={() => setToneChoice(choice)}
            >
              <span
                aria-hidden
                // 띠는 테두리 아래까지 칠한다 — 기본(padding-box)이면 테두리 칸에 띠 반대쪽 끝이 되풀이돼 비친다
                className="h-3 w-full rounded-sm border border-black/10 bg-origin-border"
                style={{ backgroundImage: toneSwatch(choice, toneColor) }}
              />
              <span className="w-full truncate">{t(TONE_LABEL[choice])}</span>
            </button>
          ))}
        </div>
        {toneChoice === 'custom' && (
          <label className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[12.5px] transition-colors hover:bg-surface-2">
            <span className="min-w-0 flex-1 truncate">{t('ui.pixelArtToneColor')}</span>
            <span className="font-mono text-[10.5px] text-muted">{toneColor}</span>
            <input
              type="color"
              value={toneColor}
              onChange={(e) => setToneColor(e.target.value)}
              className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent p-0"
            />
          </label>
        )}
        {toneChoice !== 'none' && (
          <ToolPageSliderRow>
            <Slider
              aria-label={t('ui.pixelArtToneStrength')}
              min={0}
              max={100}
              step={5}
              value={[toneStrength]}
              onValueChange={([v]) => setToneStrength(v)}
            />
          </ToolPageSliderRow>
        )}
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

const TONE_LABEL = {
  none: 'ui.pixelArtToneNone',
  mono: 'ui.pixelArtToneMono',
  sepia: 'ui.pixelArtToneSepia',
  warm: 'ui.pixelArtToneWarm',
  cool: 'ui.pixelArtToneCool',
  gameboy: 'ui.pixelArtToneGameboy',
  dusk: 'ui.pixelArtToneDusk',
  custom: 'ui.pixelArtToneCustom'
} as const satisfies Record<ToneChoice, string>

/** 버튼에 보이는 색 띠 — 실제로 칠할 띠와 같은 색 */
function toneSwatch(choice: ToneChoice, color: string): string {
  if (choice === 'none') return ORIGINAL_SWATCH
  const ramp = choice === 'custom' ? customToneRamp(color) : PIXELATE_TONE_PRESETS[choice]
  return `linear-gradient(90deg, ${ramp.join(', ')})`
}

function nearestColorStep(value: number): number {
  return PIXELATE_COLOR_STEPS.reduce((best, step) =>
    Math.abs(step - value) < Math.abs(best - value) ? step : best
  )
}
