import { describe, expect, it } from 'vitest'
import {
  buildGradientPalette,
  colorToHex,
  extractAutomaticPalette,
  parsePaletteText,
  quantizePixels
} from '../src/renderer/src/lib/pixelation'

describe('pixelation palettes', () => {
  it('parses pasted custom palettes and removes duplicate colors', () => {
    expect(parsePaletteText('#000, #fff\n336699; #336699 invalid').map(colorToHex)).toEqual([
      '#000000',
      '#ffffff',
      '#336699'
    ])
  })

  it('builds the requested gradient palette through selected anchors', () => {
    const palette = buildGradientPalette(parsePaletteText('#ff0000 #0000ff'), 16)
    expect(palette).toHaveLength(16)
    expect(colorToHex(palette[0])).toBe('#000000')
    expect(colorToHex(palette.at(-1)!)).toBe('#ffffff')
    expect(palette.some((color) => color.r > color.b)).toBe(true)
    expect(palette.some((color) => color.b > color.r)).toBe(true)
  })

  it('extracts no more than the requested automatic color count', () => {
    const pixels = new Uint8ClampedArray([
      255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255
    ])
    const palette = extractAutomaticPalette(pixels, 3)
    expect(palette).toHaveLength(3)
    expect(new Set(palette.map(colorToHex)).size).toBe(3)
  })

  it('maps colors to the custom palette without changing alpha', () => {
    const source = new Uint8ClampedArray([250, 20, 20, 255, 20, 20, 240, 96, 9, 8, 7, 0])
    const output = quantizePixels(source, parsePaletteText('#ff0000 #0000ff'))
    expect([...output]).toEqual([255, 0, 0, 255, 0, 0, 255, 96, 9, 8, 7, 0])
  })
})
