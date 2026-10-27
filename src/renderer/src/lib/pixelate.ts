/**
 * 도트화(픽셀 아트 변환) — 디렉터 로컬 툴. 외부 호출 없이 RGBA 버퍼만으로 처리한다.
 * 1) dot×dot 블록마다 알파 가중 평균색으로 축소 (알파는 반투명 없이 0/255로 잘라 외곽을 또렷하게)
 * 2) 선택 시 k-means로 팔레트 색 수를 줄임 (시드 고정 — 같은 입력은 항상 같은 결과)
 *    디더링을 켜면 Floyd–Steinberg 오차 확산으로 팔레트 사이 중간색을 점무늬로 표현
 * 3) 원본 크기 유지면 최근접 확대로 다시 키운다
 * 캔버스 API에 의존하지 않아 테스트에서 그대로 검증할 수 있다.
 */
export interface PixelBuffer {
  data: Uint8ClampedArray<ArrayBuffer>
  width: number
  height: number
}

export interface PixelateOptions {
  /** 도트 한 칸의 원본 픽셀 크기 */
  dot: number
  /** 팔레트 색 수 — 0이면 색을 줄이지 않는다 */
  colors: number
  /** 팔레트로 줄일 때 Floyd–Steinberg 디더링 적용 */
  dither: boolean
  /** true면 원본 해상도로 다시 키우고, false면 도트 1개 = 1픽셀인 작은 이미지 */
  keepSize: boolean
}

export const PIXELATE_DOT_MIN = 2
export const PIXELATE_DOT_MAX = 32
/** 고를 수 있는 팔레트 색 수 — 8색부터 2배씩 */
export const PIXELATE_COLOR_STEPS = [8, 16, 32, 64, 128, 256, 512, 1024] as const

/** 고유색이 이보다 많으면 채널당 5비트 칸(최대 32768개)으로 묶어 k-means를 돌린다 */
const BIN_THRESHOLD = 4096
/** 반복 1회 비용(점 수 × k)의 총합 상한 — 색 수가 많을 때 미리보기가 멈추지 않게 반복 횟수를 줄인다 */
const KMEANS_BUDGET = 6e7

const binKey = (r: number, g: number, b: number): number =>
  ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)

/** 블록 평균 축소 — 결과 크기는 ceil(원본 / dot), 가장자리 블록은 남은 픽셀만 평균 */
export function downsample(src: PixelBuffer, dot: number): PixelBuffer {
  const w = Math.ceil(src.width / dot)
  const h = Math.ceil(src.height / dot)
  const out = new Uint8ClampedArray(w * h * 4)
  for (let by = 0; by < h; by++) {
    for (let bx = 0; bx < w; bx++) {
      let rs = 0
      let gs = 0
      let bs = 0
      let as = 0
      let n = 0
      const yEnd = Math.min((by + 1) * dot, src.height)
      const xEnd = Math.min((bx + 1) * dot, src.width)
      for (let y = by * dot; y < yEnd; y++) {
        for (let x = bx * dot; x < xEnd; x++) {
          const i = (y * src.width + x) * 4
          const a = src.data[i + 3]
          // 투명 픽셀의 RGB가 섞여 외곽이 탁해지지 않게 알파로 가중
          rs += src.data[i] * a
          gs += src.data[i + 1] * a
          bs += src.data[i + 2] * a
          as += a
          n++
        }
      }
      const o = (by * w + bx) * 4
      if (as > 0) {
        out[o] = rs / as
        out[o + 1] = gs / as
        out[o + 2] = bs / as
      }
      out[o + 3] = as / n >= 128 ? 255 : 0
    }
  }
  return { data: out, width: w, height: h }
}

/** 고정 시드 PRNG (mulberry32) */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 불투명 픽셀의 색을 k개 팔레트로 줄인다 (제자리 수정). 고유색이 k개 이하면 그대로 둔다 */
export function quantize(img: PixelBuffer, k: number, dither = false, maxIter = 16): void {
  const { data } = img
  // 고유색 + 빈도로 묶어 가중 k-means — 픽셀 수보다 훨씬 적은 점만 돌린다
  const counts = new Map<number, number>()
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  if (counts.size <= k) return

  // 고유색이 많은 사진형 이미지는 5비트 칸으로 묶고, 칸의 대표색은 그 안 색들의 가중 평균
  const binned = counts.size > BIN_THRESHOLD
  const groups = binned ? new Map<number, [number, number, number, number]>() : null
  if (groups) {
    for (const [key, count] of counts) {
      const r = (key >> 16) & 255
      const g = (key >> 8) & 255
      const b = key & 255
      const bin = binKey(r, g, b)
      const acc = groups.get(bin)
      if (acc) {
        acc[0] += r * count
        acc[1] += g * count
        acc[2] += b * count
        acc[3] += count
      } else groups.set(bin, [r * count, g * count, b * count, count])
    }
  }
  const n = groups ? groups.size : counts.size
  const pts = new Float64Array(n * 3)
  const weights = new Float64Array(n)
  const keys = new Int32Array(n)
  let j = 0
  if (groups) {
    for (const [bin, [r, g, b, w]] of groups) {
      pts[j * 3] = r / w
      pts[j * 3 + 1] = g / w
      pts[j * 3 + 2] = b / w
      weights[j] = w
      keys[j] = bin
      j++
    }
  } else {
    for (const [key, count] of counts) {
      pts[j * 3] = (key >> 16) & 255
      pts[j * 3 + 1] = (key >> 8) & 255
      pts[j * 3 + 2] = key & 255
      weights[j] = count
      keys[j] = key
      j++
    }
  }
  if (n <= k) {
    // 칸으로 묶었더니 k개 이하 — 칸 대표색이 곧 팔레트
    const centers = pts.slice()
    const assign = Int32Array.from({ length: n }, (_, p) => p)
    applyPalette(img, centers, n, keys, assign, binned, dither)
    return
  }

  const dist2 = (p: number, c: Float64Array, ci: number): number => {
    const dr = pts[p * 3] - c[ci * 3]
    const dg = pts[p * 3 + 1] - c[ci * 3 + 1]
    const db = pts[p * 3 + 2] - c[ci * 3 + 2]
    return dr * dr + dg * dg + db * db
  }

  // k-means++ 초기화 — 빈도 가중
  const rand = rng(0x9e3779b9)
  const centers = new Float64Array(k * 3)
  const nearest = new Float64Array(n).fill(Infinity)
  let total = 0
  for (let p = 0; p < n; p++) total += weights[p]
  let pick = 0
  for (let r = rand() * total; pick < n - 1; pick++) {
    r -= weights[pick]
    if (r <= 0) break
  }
  for (let c = 0; c < k; c++) {
    centers.set(pts.subarray(pick * 3, pick * 3 + 3), c * 3)
    if (c === k - 1) break
    let sum = 0
    for (let p = 0; p < n; p++) {
      const d = dist2(p, centers, c)
      if (d < nearest[p]) nearest[p] = d
      sum += nearest[p] * weights[p]
    }
    if (sum === 0) break
    let r = rand() * sum
    pick = 0
    for (; pick < n - 1; pick++) {
      r -= nearest[pick] * weights[pick]
      if (r <= 0) break
    }
  }

  const assign = new Int32Array(n).fill(-1)
  const iters = Math.max(2, Math.min(maxIter, Math.floor(KMEANS_BUDGET / (n * k))))
  for (let iter = 0; iter < iters; iter++) {
    let changed = false
    for (let p = 0; p < n; p++) {
      let best = 0
      let bestD = Infinity
      for (let c = 0; c < k; c++) {
        const d = dist2(p, centers, c)
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
      if (assign[p] !== best) {
        assign[p] = best
        changed = true
      }
    }
    if (!changed) break
    const sums = new Float64Array(k * 4)
    for (let p = 0; p < n; p++) {
      const c = assign[p]
      const w = weights[p]
      sums[c * 4] += pts[p * 3] * w
      sums[c * 4 + 1] += pts[p * 3 + 1] * w
      sums[c * 4 + 2] += pts[p * 3 + 2] * w
      sums[c * 4 + 3] += w
    }
    for (let c = 0; c < k; c++) {
      const w = sums[c * 4 + 3]
      if (w === 0) continue // 빈 클러스터는 이전 중심 유지
      centers[c * 3] = sums[c * 4] / w
      centers[c * 3 + 1] = sums[c * 4 + 1] / w
      centers[c * 3 + 2] = sums[c * 4 + 2] / w
    }
  }

  applyPalette(img, centers, k, keys, assign, binned, dither)
}

/** 각 픽셀을 소속 점(고유색 또는 칸)의 팔레트 색으로 바꾸거나, 디더링이면 오차 확산으로 칠한다 */
function applyPalette(
  img: PixelBuffer,
  centers: Float64Array,
  k: number,
  keys: Int32Array,
  assign: Int32Array,
  binned: boolean,
  dither: boolean
): void {
  if (dither) {
    ditherToPalette(img, centers, k)
    return
  }
  const { data } = img
  const lookup = new Map<number, number>()
  for (let p = 0; p < keys.length; p++) lookup.set(keys[p], assign[p])
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    const key = binned
      ? binKey(data[i], data[i + 1], data[i + 2])
      : (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
    const c = lookup.get(key)!
    data[i] = Math.round(centers[c * 3])
    data[i + 1] = Math.round(centers[c * 3 + 1])
    data[i + 2] = Math.round(centers[c * 3 + 2])
  }
}

/**
 * Floyd–Steinberg 오차 확산 — 지그재그(serpentine)로 훑어 한 방향으로 줄무늬가 끌리지 않게 한다.
 * 투명 픽셀은 건너뛰고 오차도 넘기지 않아 외곽 바깥으로 색이 번지지 않는다.
 */
function ditherToPalette(img: PixelBuffer, centers: Float64Array, k: number): void {
  const { data, width, height } = img
  const palette = new Float64Array(k * 3)
  for (let i = 0; i < k * 3; i++) palette[i] = Math.round(centers[i])
  const buf = new Float32Array(width * height * 3)
  for (let p = 0; p < width * height; p++) {
    buf[p * 3] = data[p * 4]
    buf[p * 3 + 1] = data[p * 4 + 1]
    buf[p * 3 + 2] = data[p * 4 + 2]
  }
  // 가장 가까운 팔레트 색은 채널당 6비트 칸마다 한 번만 찾아 둔다 — 색 수가 많아도 픽셀마다 k번 비교하지 않게
  const cache = new Int16Array(1 << 18).fill(-1)
  const spread = (x: number, y: number, er: number, eg: number, eb: number, f: number): void => {
    if (x < 0 || x >= width || y >= height) return
    const p = y * width + x
    if (data[p * 4 + 3] === 0) return
    buf[p * 3] += er * f
    buf[p * 3 + 1] += eg * f
    buf[p * 3 + 2] += eb * f
  }
  for (let y = 0; y < height; y++) {
    const ltr = y % 2 === 0
    const dir = ltr ? 1 : -1
    for (let i = 0; i < width; i++) {
      const x = ltr ? i : width - 1 - i
      const p = y * width + x
      if (data[p * 4 + 3] === 0) continue
      const r = Math.min(255, Math.max(0, buf[p * 3]))
      const g = Math.min(255, Math.max(0, buf[p * 3 + 1]))
      const b = Math.min(255, Math.max(0, buf[p * 3 + 2]))
      const slot = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2)
      let best = cache[slot]
      if (best < 0) {
        // 칸 중심 기준으로 찾아 같은 칸의 모든 색이 같은 결과를 받게 한다 (결정적)
        const cr = (r & ~3) + 1.5
        const cg = (g & ~3) + 1.5
        const cb = (b & ~3) + 1.5
        let bestD = Infinity
        for (let c = 0; c < k; c++) {
          const dr = cr - palette[c * 3]
          const dg = cg - palette[c * 3 + 1]
          const db = cb - palette[c * 3 + 2]
          const d = dr * dr + dg * dg + db * db
          if (d < bestD) {
            bestD = d
            best = c
          }
        }
        cache[slot] = best
      }
      data[p * 4] = palette[best * 3]
      data[p * 4 + 1] = palette[best * 3 + 1]
      data[p * 4 + 2] = palette[best * 3 + 2]
      const er = r - palette[best * 3]
      const eg = g - palette[best * 3 + 1]
      const eb = b - palette[best * 3 + 2]
      spread(x + dir, y, er, eg, eb, 7 / 16)
      spread(x - dir, y + 1, er, eg, eb, 3 / 16)
      spread(x, y + 1, er, eg, eb, 5 / 16)
      spread(x + dir, y + 1, er, eg, eb, 1 / 16)
    }
  }
}

/** 최근접 확대 — 원본 크기(width×height)로 정확히 맞춘다 */
export function upscaleNearest(
  small: PixelBuffer,
  dot: number,
  width: number,
  height: number
): PixelBuffer {
  const out = new Uint8ClampedArray(width * height * 4)
  const src = new Uint32Array(small.data.buffer, small.data.byteOffset, small.width * small.height)
  const dst = new Uint32Array(out.buffer)
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / dot) * small.width
    for (let x = 0; x < width; x++) dst[y * width + x] = src[row + Math.floor(x / dot)]
  }
  return { data: out, width, height }
}

/** 축소 + 팔레트 축소까지 — 미리보기는 이 결과를 CSS로 키워 보여 준다 */
export function pixelateSmall(
  src: PixelBuffer,
  opts: Pick<PixelateOptions, 'dot' | 'colors' | 'dither'>
): PixelBuffer {
  const small = downsample(src, opts.dot)
  if (opts.colors > 0) quantize(small, opts.colors, opts.dither)
  return small
}

export function pixelate(src: PixelBuffer, opts: PixelateOptions): PixelBuffer {
  const small = pixelateSmall(src, opts)
  return opts.keepSize ? upscaleNearest(small, opts.dot, src.width, src.height) : small
}
