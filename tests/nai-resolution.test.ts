import { describe, expect, it } from 'vitest'
import {
  NAI_MAX_GENERATION_PIXELS,
  fitNaiGenerationResolution,
  snapNaiDimension,
  snapNaiResolution
} from '../src/shared/nai-resolution'

describe('NAI 소스 해상도 스냅', () => {
  it('64 배수로 맞추고 서버 전송 크기와 비용 표시가 공유할 값을 반환한다', () => {
    expect(snapNaiResolution(300, 412)).toEqual({ width: 320, height: 384 })
  })
})

describe('NAI Custom 생성 해상도 보정', () => {
  it('공식 웹처럼 각 변을 64 배수로 맞춘다', () => {
    expect(snapNaiDimension(1440)).toBe(1472)
    expect(fitNaiGenerationResolution(1000, 1000)).toEqual({ width: 1024, height: 1024 })
  })

  it('정확히 3 Mi 픽셀인 해상도는 그대로 허용한다', () => {
    const resolution = fitNaiGenerationResolution(2048, 1536)
    expect(resolution).toEqual({ width: 2048, height: 1536 })
    expect(resolution!.width * resolution!.height).toBe(NAI_MAX_GENERATION_PIXELS)
  })

  it('높이를 마지막으로 편집한 QHD 입력은 높이를 유지하고 폭을 줄인다', () => {
    expect(fitNaiGenerationResolution(2560, 1440, 'height')).toEqual({
      width: 2112,
      height: 1472
    })
  })

  it('폭을 마지막으로 편집한 QHD 입력은 폭을 유지하고 높이를 줄인다', () => {
    expect(fitNaiGenerationResolution(2560, 1440, 'width')).toEqual({
      width: 2560,
      height: 1216
    })
  })

  it('한 변이 2048을 넘어도 총 픽셀 상한 이하면 유지한다', () => {
    expect(fitNaiGenerationResolution(3200, 768, 'width')).toEqual({
      width: 3200,
      height: 768
    })
  })
})
