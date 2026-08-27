export const NAI_RESOLUTION_STEP = 64
export const NAI_MIN_RESOLUTION = 64
export const NAI_MAX_GENERATION_PIXELS = 3 * 1024 * 1024

export type ResolutionDimension = 'width' | 'height'

export function snapNaiDimension(value: number): number {
  if (!Number.isFinite(value)) return Number.NaN
  return Math.max(NAI_MIN_RESOLUTION, Math.round(value / NAI_RESOLUTION_STEP) * NAI_RESOLUTION_STEP)
}

/**
 * NovelAI 웹의 Custom 해상도 규칙: 64 배수로 맞추고 총 3 Mi 픽셀을 넘으면
 * 마지막으로 편집한 변은 유지하면서 반대 변을 64 단위로 줄인다.
 */
export function fitNaiGenerationResolution(
  inputWidth: number,
  inputHeight: number,
  preservedDimension: ResolutionDimension = 'height'
): { width: number; height: number } | null {
  let width = snapNaiDimension(inputWidth)
  let height = snapNaiDimension(inputHeight)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width * height <= NAI_MAX_GENERATION_PIXELS) return { width, height }

  const maxPreservedDimension = NAI_MAX_GENERATION_PIXELS / NAI_MIN_RESOLUTION
  if (preservedDimension === 'width') {
    width = Math.min(width, maxPreservedDimension)
    height = Math.max(
      NAI_MIN_RESOLUTION,
      Math.floor(NAI_MAX_GENERATION_PIXELS / width / NAI_RESOLUTION_STEP) * NAI_RESOLUTION_STEP
    )
  } else {
    height = Math.min(height, maxPreservedDimension)
    width = Math.max(
      NAI_MIN_RESOLUTION,
      Math.floor(NAI_MAX_GENERATION_PIXELS / height / NAI_RESOLUTION_STEP) * NAI_RESOLUTION_STEP
    )
  }

  return { width, height }
}

/** 소스 해상도를 유효 NAI 해상도로 스냅 — 64 배수, 픽셀 상한 내에서 비율 최대한 보존 */
export function snapNaiResolution(w: number, h: number): { width: number; height: number } {
  const maxPixels = 1216 * 1216
  let width = w
  let height = h
  if (width * height > maxPixels) {
    const scale = Math.sqrt(maxPixels / (width * height))
    width *= scale
    height *= scale
  }
  const snap = (value: number): number => snapNaiDimension(value)
  return { width: snap(width), height: snap(height) }
}
