import { describe, expect, it } from 'vitest'
import { downsample, pixelate, quantize, type PixelBuffer } from '../src/renderer/src/lib/pixelate'

function buffer(
  width: number,
  height: number,
  px: (x: number, y: number) => number[]
): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(px(x, y), (y * width + x) * 4)
  return { data, width, height }
}

const at = (img: PixelBuffer, x: number, y: number): number[] => [
  ...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)
]

describe('pixelate', () => {
  it('averages each block and keeps partial edge blocks', () => {
    const src = buffer(5, 2, (x) =>
      x < 2 ? [0, 0, 0, 255] : x < 4 ? [200, 100, 50, 255] : [10, 20, 30, 255]
    )
    const small = downsample(src, 2)
    expect([small.width, small.height]).toEqual([3, 1])
    expect(at(small, 0, 0)).toEqual([0, 0, 0, 255])
    expect(at(small, 1, 0)).toEqual([200, 100, 50, 255])
    expect(at(small, 2, 0)).toEqual([10, 20, 30, 255])
  })

  it('ignores transparent pixel colors and binarizes alpha', () => {
    const mostlyOpaque = downsample(
      buffer(2, 2, (x, y) => (x === 0 && y === 0 ? [255, 255, 255, 0] : [100, 0, 0, 255])),
      2
    )
    expect(at(mostlyOpaque, 0, 0)).toEqual([100, 0, 0, 255])
    const mostlyClear = downsample(
      buffer(2, 2, (x, y) => (x === 0 && y === 0 ? [100, 0, 0, 255] : [0, 0, 0, 0])),
      2
    )
    expect(at(mostlyClear, 0, 0)[3]).toBe(0)
  })

  it('reduces the palette to at most k colors deterministically', () => {
    const make = (): PixelBuffer => buffer(16, 16, (x, y) => [x * 16, y * 16, (x + y) * 8, 255])
    const a = make()
    const b = make()
    quantize(a, 4)
    quantize(b, 4)
    const colors = new Set<string>()
    for (let i = 0; i < a.data.length; i += 4) colors.add(a.data.subarray(i, i + 3).join())
    expect(colors.size).toBeLessThanOrEqual(4)
    expect(colors.size).toBeGreaterThan(1)
    expect(a.data).toEqual(b.data)
  })

  it('upscales back to the exact original size when keeping size', () => {
    const src = buffer(7, 5, (x, y) => [x * 30, y * 40, 0, 255])
    const kept = pixelate(src, { dot: 3, colors: 0, dither: false, keepSize: true })
    expect([kept.width, kept.height]).toEqual([7, 5])
    expect(at(kept, 0, 0)).toEqual(at(kept, 2, 2))
    expect(at(kept, 6, 4)).toEqual(at(downsample(src, 3), 2, 1))
    const small = pixelate(src, { dot: 3, colors: 0, dither: false, keepSize: false })
    expect([small.width, small.height]).toEqual([3, 2])
  })

  it('dithers with palette colors only and spreads them across a gradient', () => {
    const make = (): PixelBuffer => buffer(64, 8, (x) => [x * 4, x * 4, x * 4, 255])
    const colorsOf = (img: PixelBuffer): Set<string> => {
      const set = new Set<string>()
      for (let i = 0; i < img.data.length; i += 4) set.add(img.data.subarray(i, i + 3).join())
      return set
    }
    const flat = make()
    quantize(flat, 2)
    const dithered = make()
    quantize(dithered, 2, true)
    const again = make()
    quantize(again, 2, true)

    expect(colorsOf(dithered).size).toBeLessThanOrEqual(2)
    for (const c of colorsOf(dithered)) expect(colorsOf(flat)).toContain(c)
    expect(dithered.data).toEqual(again.data)
    // 2색 평탄화는 한가운데서 한 번만 바뀌지만, 디더링은 행 안에서 여러 번 섞인다
    const flips = (img: PixelBuffer): number => {
      let n = 0
      for (let x = 1; x < img.width; x++) if (img.data[x * 4] !== img.data[(x - 1) * 4]) n++
      return n
    }
    expect(flips(flat)).toBe(1)
    expect(flips(dithered)).toBeGreaterThan(4)
  })

  it('leaves transparent pixels untouched when dithering', () => {
    const img = buffer(8, 1, (x) => (x % 2 ? [0, 0, 0, 0] : [x * 30, 0, 255 - x * 30, 255]))
    quantize(img, 2, true)
    for (let x = 1; x < 8; x += 2) expect(at(img, x, 0)).toEqual([0, 0, 0, 0])
  })

  it('reduces photo-like images with many unique colors to at most k colors', () => {
    // 128×128 = 16384개의 고유색 — 칸으로 묶는 경로를 탄다
    const make = (): PixelBuffer => buffer(128, 128, (x, y) => [x * 2, y * 2, (x + y) & 255, 255])
    const colorsOf = (img: PixelBuffer): number => {
      const set = new Set<number>()
      for (let i = 0; i < img.data.length; i += 4)
        set.add((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2])
      return set.size
    }
    for (const dither of [false, true]) {
      const img = make()
      quantize(img, 1024, dither)
      const again = make()
      quantize(again, 1024, dither)
      expect(colorsOf(img)).toBeLessThanOrEqual(1024)
      expect(colorsOf(img)).toBeGreaterThan(256)
      expect(img.data).toEqual(again.data)
    }
  })
})
