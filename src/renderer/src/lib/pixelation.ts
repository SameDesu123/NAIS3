export interface RgbColor {
  r: number
  g: number
  b: number
}

interface HistogramColor extends RgbColor {
  count: number
}

interface ColorBox {
  colors: HistogramColor[]
  count: number
  range: number
}

interface OklabColor {
  l: number
  a: number
  b: number
}

const clampByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)))

export function parseHexColor(value: string): RgbColor | null {
  const raw = value.trim().replace(/^#/, '')
  const hex =
    raw.length === 3
      ? raw
          .split('')
          .map((part) => part + part)
          .join('')
      : raw
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null
  const number = Number.parseInt(hex, 16)
  return { r: (number >> 16) & 255, g: (number >> 8) & 255, b: number & 255 }
}

export function colorToHex(color: RgbColor): string {
  const channel = (value: number): string => clampByte(value).toString(16).padStart(2, '0')
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`
}

export function parsePaletteText(value: string): RgbColor[] {
  const seen = new Set<string>()
  const colors: RgbColor[] = []
  for (const token of value.split(/[\s,;]+/)) {
    const color = parseHexColor(token)
    if (!color) continue
    const hex = colorToHex(color)
    if (seen.has(hex)) continue
    seen.add(hex)
    colors.push(color)
  }
  return colors
}

function srgbToLinear(value: number): number {
  const channel = value / 255
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(value: number): number {
  const channel = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
  return clampByte(channel * 255)
}

function rgbToOklab(color: RgbColor): OklabColor {
  const r = srgbToLinear(color.r)
  const g = srgbToLinear(color.g)
  const b = srgbToLinear(color.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  }
}

function oklabToRgb(color: OklabColor): RgbColor {
  const l = (color.l + 0.3963377774 * color.a + 0.2158037573 * color.b) ** 3
  const m = (color.l - 0.1055613458 * color.a - 0.0638541728 * color.b) ** 3
  const s = (color.l - 0.0894841775 * color.a - 1.291485548 * color.b) ** 3
  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  }
}

/** Build a versatile tonal ramp through user-selected colors in perceptual OKLab space. */
export function buildGradientPalette(anchors: RgbColor[], count: number): RgbColor[] {
  const safeCount = Math.max(2, Math.min(256, Math.round(count)))
  const selected = anchors.length > 0 ? anchors : [{ r: 128, g: 128, b: 128 }]
  const stops = [{ r: 0, g: 0, b: 0 }, ...selected, { r: 255, g: 255, b: 255 }]
  const labs = stops.map(rgbToOklab)
  const result: RgbColor[] = []
  for (let index = 0; index < safeCount; index++) {
    const position = (index / (safeCount - 1)) * (labs.length - 1)
    const segment = Math.min(labs.length - 2, Math.floor(position))
    const amount = position - segment
    const from = labs[segment]
    const to = labs[segment + 1]
    result.push(
      oklabToRgb({
        l: from.l + (to.l - from.l) * amount,
        a: from.a + (to.a - from.a) * amount,
        b: from.b + (to.b - from.b) * amount
      })
    )
  }
  return result
}

function makeColorBox(colors: HistogramColor[]): ColorBox {
  let rMin = 255
  let rMax = 0
  let gMin = 255
  let gMax = 0
  let bMin = 255
  let bMax = 0
  let count = 0
  for (const color of colors) {
    rMin = Math.min(rMin, color.r)
    rMax = Math.max(rMax, color.r)
    gMin = Math.min(gMin, color.g)
    gMax = Math.max(gMax, color.g)
    bMin = Math.min(bMin, color.b)
    bMax = Math.max(bMax, color.b)
    count += color.count
  }
  return { colors, count, range: Math.max(rMax - rMin, gMax - gMin, bMax - bMin) }
}

function splitColorBox(box: ColorBox): [ColorBox, ColorBox] | null {
  if (box.colors.length < 2) return null
  let rMin = 255
  let rMax = 0
  let gMin = 255
  let gMax = 0
  let bMin = 255
  let bMax = 0
  for (const color of box.colors) {
    rMin = Math.min(rMin, color.r)
    rMax = Math.max(rMax, color.r)
    gMin = Math.min(gMin, color.g)
    gMax = Math.max(gMax, color.g)
    bMin = Math.min(bMin, color.b)
    bMax = Math.max(bMax, color.b)
  }
  const ranges = { r: rMax - rMin, g: gMax - gMin, b: bMax - bMin }
  const channel: keyof RgbColor =
    ranges.r >= ranges.g && ranges.r >= ranges.b ? 'r' : ranges.g >= ranges.b ? 'g' : 'b'
  const colors = [...box.colors].sort((left, right) => left[channel] - right[channel])
  const midpoint = box.count / 2
  let accumulated = 0
  let splitAt = 1
  for (let index = 0; index < colors.length - 1; index++) {
    accumulated += colors[index].count
    if (accumulated >= midpoint) {
      splitAt = index + 1
      break
    }
  }
  return [makeColorBox(colors.slice(0, splitAt)), makeColorBox(colors.slice(splitAt))]
}

/** Extract representative colors with a weighted median-cut over a compact 5-bit histogram. */
export function extractAutomaticPalette(
  pixels: Uint8ClampedArray,
  requestedCount: number
): RgbColor[] {
  const histogram = new Map<number, { count: number; r: number; g: number; b: number }>()
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] < 16) continue
    const r = pixels[index]
    const g = pixels[index + 1]
    const b = pixels[index + 2]
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const entry = histogram.get(key)
    if (entry) {
      entry.count++
      entry.r += r
      entry.g += g
      entry.b += b
    } else {
      histogram.set(key, { count: 1, r, g, b })
    }
  }
  if (histogram.size === 0) return [{ r: 0, g: 0, b: 0 }]
  const colors = [...histogram.values()].map((entry) => ({
    count: entry.count,
    r: Math.round(entry.r / entry.count),
    g: Math.round(entry.g / entry.count),
    b: Math.round(entry.b / entry.count)
  }))
  const target = Math.max(1, Math.min(256, Math.round(requestedCount), colors.length))
  const boxes = [makeColorBox(colors)]
  while (boxes.length < target) {
    let selectedIndex = -1
    let selectedScore = -1
    for (let index = 0; index < boxes.length; index++) {
      const box = boxes[index]
      if (box.colors.length < 2) continue
      const score = box.range * box.count
      if (score > selectedScore) {
        selectedIndex = index
        selectedScore = score
      }
    }
    if (selectedIndex < 0) break
    const split = splitColorBox(boxes[selectedIndex])
    if (!split) break
    boxes.splice(selectedIndex, 1, ...split)
  }
  return boxes
    .map((box) => {
      let r = 0
      let g = 0
      let b = 0
      for (const color of box.colors) {
        r += color.r * color.count
        g += color.g * color.count
        b += color.b * color.count
      }
      return { r: r / box.count, g: g / box.count, b: b / box.count }
    })
    .sort((left, right) => rgbToOklab(left).l - rgbToOklab(right).l)
    .map((color) => ({ r: clampByte(color.r), g: clampByte(color.g), b: clampByte(color.b) }))
}

/** Map opaque pixels to the nearest palette color while preserving the source alpha channel. */
export function quantizePixels(
  source: Uint8ClampedArray,
  palette: readonly RgbColor[]
): Uint8ClampedArray {
  const colors = palette.length > 0 ? palette : [{ r: 0, g: 0, b: 0 }]
  const labs = colors.map(rgbToOklab)
  const cache = new Map<number, RgbColor>()
  const output = new Uint8ClampedArray(source)
  for (let index = 0; index < output.length; index += 4) {
    if (output[index + 3] === 0) continue
    const key =
      ((output[index] >> 3) << 10) | ((output[index + 1] >> 3) << 5) | (output[index + 2] >> 3)
    let nearest = cache.get(key)
    if (!nearest) {
      const sample = rgbToOklab({
        r: ((key >> 10) & 31) * 8 + 4,
        g: ((key >> 5) & 31) * 8 + 4,
        b: (key & 31) * 8 + 4
      })
      let distance = Number.POSITIVE_INFINITY
      nearest = colors[0]
      for (let paletteIndex = 0; paletteIndex < labs.length; paletteIndex++) {
        const candidate = labs[paletteIndex]
        const nextDistance =
          (sample.l - candidate.l) ** 2 +
          (sample.a - candidate.a) ** 2 +
          (sample.b - candidate.b) ** 2
        if (nextDistance < distance) {
          distance = nextDistance
          nearest = colors[paletteIndex]
        }
      }
      cache.set(key, nearest)
    }
    output[index] = nearest.r
    output[index + 1] = nearest.g
    output[index + 2] = nearest.b
  }
  return output
}
