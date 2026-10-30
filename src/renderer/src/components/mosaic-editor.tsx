import { Brush, Grid3x3, RotateCcw } from 'lucide-react'
import { useRef, useState } from 'react'
import { useT } from '../lib/i18n'
import { useImageData } from '../lib/image-data'
import { intSetting, useStoredSetting } from '../lib/stored-setting'
import {
  ToolPage,
  ToolPageActions,
  ToolPageSection,
  ToolPageSliderRow,
  ToolPageStage,
  type LocalEditorProps
} from './tool-page'
import { Button } from './ui/button'
import { Slider } from './ui/slider'

/** 최소 붓 크기 — 얼굴/눈처럼 좁은 영역을 정밀하게 가릴 수 있게 (표시 픽셀 기준) */
const BRUSH_MIN = 3
const BRUSH_MAX = 150
const CELL_MIN = 5
const CELL_MAX = 30
const CELL_SETTING = intSetting(CELL_MIN, CELL_MAX)
const BRUSH_SETTING = intSetting(BRUSH_MIN, BRUSH_MAX)

/**
 * 모자이크 편집 페이지 (디렉터 로컬 툴, NAIS2 이식):
 * 원본은 <img>로 깔고, 캔버스는 모자이크 셀만 얹는 투명 오버레이 (마스크 에디터와 동일 구조).
 * 붓이 지나간 영역을 칸 크기 그리드에 스냅해 원본 ImageData의 셀 평균색으로 채운다
 * — 색을 항상 원본에서 샘플링하므로 같은 곳을 반복해 칠해도 뭉개지지 않는다.
 * 적용 시 원본 + 오버레이를 오프스크린에서 합성해 반환한다.
 */
export function MosaicEditorPage({
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
  const doneCells = useRef(new Set<string>()) // 현재 칸 그리드에서 이미 칠한 셀
  const [cell, setCell] = useStoredSetting('mosaic_pixel', 10, CELL_SETTING)
  // 인페인트 마스크와 동일한 기본 붓 크기 — 화면에 보이는 크기(표시 픽셀) 기준 반경
  const [brush, setBrush] = useStoredSetting('mosaic_brush', 28, BRUSH_SETTING)
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null) // 붓 윤곽 (표시 픽셀)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)

  /** 붓 중심 사각 영역을 그리드에 스냅해 셀별로 원본 평균색 fillRect */
  function mosaicAt(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
    if (!original) return
    const { data } = original
    const x0 = Math.max(0, Math.floor((cx - r) / cell) * cell)
    const y0 = Math.max(0, Math.floor((cy - r) / cell) * cell)
    for (let py = y0; py < Math.min(cy + r, height); py += cell) {
      for (let px = x0; px < Math.min(cx + r, width); px += cell) {
        const key = `${px},${py}`
        if (doneCells.current.has(key)) continue
        doneCells.current.add(key)
        // 셀 평균색 (NAIS2는 좌상단 1픽셀 샘플 — 평균으로 개선)
        let rs = 0
        let gs = 0
        let bs = 0
        let as = 0
        let n = 0
        const yEnd = Math.min(py + cell, height)
        const xEnd = Math.min(px + cell, width)
        for (let y = py; y < yEnd; y++) {
          for (let x = px; x < xEnd; x++) {
            const i = (y * width + x) * 4
            rs += data[i]
            gs += data[i + 1]
            bs += data[i + 2]
            as += data[i + 3]
            n++
          }
        }
        // 투명 영역은 덮어쓰기 위해 지우고 다시 채움 (fillRect는 알파 블렌딩이라)
        ctx.clearRect(px, py, xEnd - px, yEnd - py)
        ctx.fillStyle = `rgba(${(rs / n) | 0}, ${(gs / n) | 0}, ${(bs / n) | 0}, ${as / n / 255})`
        ctx.fillRect(px, py, xEnd - px, yEnd - py)
      }
    }
  }

  function paint(e: React.PointerEvent<HTMLCanvasElement>): void {
    const rect = e.currentTarget.getBoundingClientRect()
    setHover({ x: e.clientX - rect.left, y: e.clientY - rect.top })
    const canvas = canvasRef.current
    if (!canvas || !drawing.current || rect.width === 0) return
    const ctx = canvas.getContext('2d')!
    // 화면 좌표 → 원본 좌표. 붓 크기도 원본 해상도로 스케일 (화면에서 보이는 크기 유지)
    const scale = width / rect.width
    const x = (e.clientX - rect.left) * scale
    const y = (e.clientY - rect.top) * scale
    const r = brush * scale
    // 빠르게 드래그해도 빈틈이 없게 이전 점부터 보간
    if (last.current) {
      const dx = x - last.current.x
      const dy = y - last.current.y
      const dist = Math.hypot(dx, dy)
      const step = Math.max(cell, r / 2)
      for (let d = step; d < dist; d += step) {
        mosaicAt(ctx, last.current.x + (dx * d) / dist, last.current.y + (dy * d) / dist, r)
      }
    }
    mosaicAt(ctx, x, y, r)
    last.current = { x, y }
  }

  function endStroke(): void {
    drawing.current = false
    last.current = null
  }

  function reset(): void {
    canvasRef.current?.getContext('2d')!.clearRect(0, 0, width, height)
    doneCells.current.clear()
  }

  /** 원본 + 모자이크 오버레이를 오프스크린에서 합성 → base64 PNG */
  function exportResult(): string | null {
    if (!original || !canvasRef.current) return null
    const out = document.createElement('canvas')
    out.width = width
    out.height = height
    const ctx = out.getContext('2d')!
    ctx.putImageData(original, 0, 0)
    ctx.drawImage(canvasRef.current, 0, 0)
    return out.toDataURL('image/png').split(',')[1]
  }

  return (
    <ToolPage
      icon={Grid3x3}
      title={t('ui.mosaic')}
      description={t('ui.mosaicInstructions')}
      onBack={onCancel}
      stage={
        <ToolPageStage width={width} height={height}>
          {/* 원본·원본 해상도 오버레이는 넘김이 끝난 뒤에 — 큰 이미지는 해독·할당만으로 넘김이 끊긴다 */}
          {ready && (
            <img
              src={`data:image/png;base64,${imageBase64}`}
              className="pointer-events-none absolute inset-0 h-full w-full select-none"
              decoding="async"
              draggable={false}
              alt=""
            />
          )}
          {/* 모자이크 셀만 얹는 오버레이 — 원본 해상도, CSS로만 맞춰 표시 */}
          <canvas
            ref={canvasRef}
            width={ready ? width : 0}
            height={ready ? height : 0}
            className="absolute inset-0 h-full w-full cursor-crosshair"
            style={{ touchAction: 'none' }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              drawing.current = true
              last.current = null
              paint(e)
            }}
            onPointerMove={paint}
            onPointerUp={endStroke}
            onPointerLeave={() => {
              endStroke()
              setHover(null)
            }}
          />
          {hover && (
            <div
              className="pointer-events-none absolute rounded-sm border border-white/80 shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
              style={{
                left: hover.x - brush,
                top: hover.y - brush,
                width: brush * 2,
                height: brush * 2
              }}
            />
          )}
        </ToolPageStage>
      }
      footer={
        <ToolPageActions
          disabled={!original}
          exportResult={exportResult}
          fileName={`mosaic_${width}x${height}.png`}
          downloadTitle={t('ui.mosaicSaveToFile')}
          onApply={onConfirm}
          onCancel={onCancel}
        />
      }
    >
      <ToolPageSection icon={Grid3x3} label={t('ui.mosaicCellSize')} value={`${cell}px`}>
        <ToolPageSliderRow>
          <Slider
            aria-label={t('ui.mosaicCellSize')}
            min={CELL_MIN}
            max={CELL_MAX}
            step={1}
            value={[cell]}
            onValueChange={([v]) => {
              setCell(v)
              doneCells.current.clear() // 그리드가 바뀌면 셀 추적 초기화
            }}
          />
        </ToolPageSliderRow>
      </ToolPageSection>

      <ToolPageSection icon={Brush} label={t('ui.mosaicBrushSize')} value={`${brush}px`}>
        <ToolPageSliderRow>
          <Slider
            aria-label={t('ui.mosaicBrushSize')}
            min={BRUSH_MIN}
            max={BRUSH_MAX}
            step={1}
            value={[brush]}
            onValueChange={([v]) => setBrush(v)}
          />
        </ToolPageSliderRow>
      </ToolPageSection>

      <Button variant="ghost" className="justify-start gap-2 px-2.5" onClick={reset}>
        <RotateCcw size={13} /> {t('ui.reset')}
      </Button>
    </ToolPage>
  )
}
