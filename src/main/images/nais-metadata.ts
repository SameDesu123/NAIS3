import type { ImageMetadata } from '../../shared/types'

// electron·sharp에 의존하지 않는다 — 파일을 다시 인코딩하지 않고 청크만 끼워 넣는다

/**
 * 모든 출력 파일에 넣는 NAIS 메타데이터 (PNG tEXt / WebP XMP, 둘 다 base64 JSON).
 * 파일만 있어도 생성 설정을 되살릴 수 있게 한다 — DB payload는 예전 파일의 폴백일 뿐이다.
 *
 * - version 1: 예전 앱이 쓰던 {version, promptParts}. 예전 앱은 promptParts만 읽으므로
 *   같은 키에 필드를 더한 version 2도 그대로 읽는다.
 * - NAI 자체 메타데이터(PNG Comment·stealth, WebP의 기존 청크)는 건드리지 않는다.
 * - 이 파일이 NAIS 출력인지는 이 메타데이터로만 판단한다 — 파일 이름은 근거가 아니다.
 */
export const NAIS_METADATA_KEY = 'nais3-params'
export const NAIS_METADATA_VERSION = 2

export interface NaisMetadata {
  app: 'NAIS3'
  version: number
  appVersion?: string
  kind: string
  seed: number
  /** ISO 8601 */
  createdAt: string
  /** 선택 — 어떤 기능도 이 값에 기대지 않는다 */
  mediaId?: string
  /** 재현 설정: NAI 요청 필드 그대로, 이미지 데이터(i2i 원본·마스크·바이브·레퍼런스)는 뺀다 */
  request?: Record<string, unknown>
  promptParts?: ImageMetadata['promptParts']
}

/** 설정이 아니라 이미지 데이터를 담는 요청 필드 (payload.ts) — 캐시 키도 다른 기기에선 의미가 없다 */
const IMAGE_DATA_KEYS = new Set([
  'image',
  'mask',
  'image_cache_secret_key',
  'reference_image_multiple',
  'reference_image_multiple_cached',
  'director_reference_images',
  'director_reference_images_cached'
])
const BASE64_RUN = /^[A-Za-z0-9+/=\r\n]{1024,}$/
/**
 * 프롬프트·네거티브 텍스트 필드 (payload.ts). 태그를 줄바꿈으로 나열한 긴 프롬프트는 base64 글자만으로
 * 이뤄질 수 있다 — 아래 휴리스틱은 이름을 모르는 필드에만 쓴다
 */
const TEXT_KEYS = new Set([
  'input',
  'prompt',
  'negative_prompt',
  'uc',
  'base_caption',
  'char_caption'
])

function withoutImageData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutImageData)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) {
      if (IMAGE_DATA_KEYS.has(key)) continue
      if (TEXT_KEYS.has(key) && typeof v === 'string') {
        out[key] = v
        continue
      }
      const kept = withoutImageData(v)
      if (kept !== undefined) out[key] = kept
    }
    return out
  }
  // 이름을 모르는 새 필드로 이미지가 들어와도 파일에 새지 않게 — 긴 base64 문자열은 버린다
  if (typeof value === 'string' && BASE64_RUN.test(value)) return undefined
  return value
}

/** 전송 payload(JSON) → 재현 설정. JSON이 아니면 undefined */
export function reproductionSettings(sentPayload: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(sentPayload) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return withoutImageData(parsed) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export function buildNaisMetadata(input: {
  sentPayload: string
  kind: string
  seed: number
  createdAt: Date
  appVersion?: string
  mediaId?: string
  localMetadata?: Pick<ImageMetadata, 'promptParts'>
}): NaisMetadata {
  return {
    app: 'NAIS3',
    version: NAIS_METADATA_VERSION,
    ...(input.appVersion ? { appVersion: input.appVersion } : {}),
    kind: input.kind,
    seed: input.seed,
    createdAt: input.createdAt.toISOString(),
    ...(input.mediaId ? { mediaId: input.mediaId } : {}),
    request: reproductionSettings(input.sentPayload),
    ...(input.localMetadata?.promptParts ? { promptParts: input.localMetadata.promptParts } : {})
  }
}

/** 키 값(base64 JSON 또는 JSON) → 객체. version 1(promptParts만)도 돌려준다 */
export function parseNaisParams(raw: string): Partial<NaisMetadata> | undefined {
  for (const text of [Buffer.from(raw, 'base64').toString('utf8'), raw]) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Partial<NaisMetadata>
    } catch {
      // 다음 후보 확인
    }
  }
  return undefined
}

/** 출력 파일 버퍼에 메타데이터를 넣는다. PNG·WebP가 아니거나 구조를 모르면 그대로 돌려준다 */
export function embedNaisMetadata(image: Buffer, meta: NaisMetadata): Buffer {
  const value = Buffer.from(JSON.stringify(meta), 'utf8').toString('base64')
  if (isPng(image)) return embedPng(image, value)
  if (isWebp(image)) return embedWebp(image, value)
  return image
}

/** WebP XMP에서 NAIS 메타데이터 읽기 (PNG는 metadata.ts의 텍스트 청크 파서가 읽는다) */
export function readWebpNaisParams(image: Buffer): Partial<NaisMetadata> | undefined {
  const chunks = parseRiff(image)
  const xmp = chunks?.find((c) => c.fourcc === 'XMP ')
  if (!xmp) return undefined
  const match = XMP_VALUE.exec(xmp.data.toString('utf8'))
  return match ? parseNaisParams(match[1]) : undefined
}

// ── PNG ────────────────────────────────────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function isPng(buf: Buffer): boolean {
  return buf.length >= 33 && buf.subarray(0, 8).equals(PNG_SIG)
}

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function textChunk(keyword: string, value: string): Buffer {
  const data = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(value, 'latin1')
  ])
  const type = Buffer.from('tEXt', 'ascii')
  const out = Buffer.alloc(4 + 4 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  type.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length)
  return out
}

/** IHDR 바로 뒤에 끼운다 — NAI의 텍스트 청크와 stealth 알파는 그대로 남는다 */
function embedPng(png: Buffer, value: string): Buffer {
  const ihdrEnd = 33
  return Buffer.concat([
    png.subarray(0, ihdrEnd),
    textChunk(NAIS_METADATA_KEY, value),
    png.subarray(ihdrEnd)
  ])
}

// ── WebP (RIFF) ────────────────────────────────────────────────
// XMP를 쓰려면 확장 포맷(VP8X)이어야 한다. 단순 포맷(VP8/VP8L 하나)이면 VP8X를 앞에 만든다.
// 이미지 데이터는 다시 인코딩하지 않는다

const XMP_NS = 'https://github.com/sunanakgo/NAIS3/ns/1.0/'
const XMP_VALUE = /<nais3:params>([A-Za-z0-9+/=]+)<\/nais3:params>/
// VP8X 플래그 바이트: ICC 0x20 · 알파 0x10 · EXIF 0x08 · XMP 0x04 · 애니메이션 0x02
const VP8X_ALPHA = 0x10
const VP8X_XMP = 0x04

interface RiffChunk {
  fourcc: string
  data: Buffer
}

function isWebp(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  )
}

function parseRiff(buf: Buffer): RiffChunk[] | null {
  if (!isWebp(buf)) return null
  const end = Math.min(buf.length, 8 + buf.readUInt32LE(4))
  const chunks: RiffChunk[] = []
  let off = 12
  while (off + 8 <= end) {
    const size = buf.readUInt32LE(off + 4)
    const start = off + 8
    if (start + size > end) return null
    chunks.push({
      fourcc: buf.toString('ascii', off, off + 4),
      data: buf.subarray(start, start + size)
    })
    off = start + size + (size & 1)
  }
  return chunks
}

function writeRiff(chunks: RiffChunk[]): Buffer {
  const parts: Buffer[] = []
  for (const c of chunks) {
    const header = Buffer.alloc(8)
    header.write(c.fourcc, 0, 'ascii')
    header.writeUInt32LE(c.data.length, 4)
    parts.push(header, c.data)
    if (c.data.length & 1) parts.push(Buffer.alloc(1))
  }
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(4 + body.length, 4)
  head.write('WEBP', 8, 'ascii')
  return Buffer.concat([head, body])
}

/** 단순 포맷의 캔버스 크기와 알파 사용 여부 (VP8 키프레임 헤더 / VP8L 헤더) */
function simpleImageInfo(
  chunks: RiffChunk[]
): { width: number; height: number; alpha: boolean } | null {
  const vp8 = chunks.find((c) => c.fourcc === 'VP8 ')
  if (vp8 && vp8.data.length >= 10 && vp8.data.readUIntBE(3, 3) === 0x9d012a) {
    return {
      width: vp8.data.readUInt16LE(6) & 0x3fff,
      height: vp8.data.readUInt16LE(8) & 0x3fff,
      alpha: false
    }
  }
  const vp8l = chunks.find((c) => c.fourcc === 'VP8L')
  if (vp8l && vp8l.data.length >= 5 && vp8l.data[0] === 0x2f) {
    const bits = vp8l.data.readUInt32LE(1)
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      alpha: ((bits >>> 28) & 1) === 1
    }
  }
  return null
}

function vp8xChunk(info: { width: number; height: number; alpha: boolean }): RiffChunk {
  const data = Buffer.alloc(10)
  data[0] = info.alpha ? VP8X_ALPHA : 0
  data.writeUIntLE(info.width - 1, 4, 3)
  data.writeUIntLE(info.height - 1, 7, 3)
  return { fourcc: 'VP8X', data }
}

function xmpDescription(value: string): string {
  return `<rdf:Description rdf:about="" xmlns:nais3="${XMP_NS}"><nais3:params>${value}</nais3:params></rdf:Description>`
}

function xmpPacket(value: string): string {
  return (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    xmpDescription(value) +
    '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
  )
}

function embedWebp(webp: Buffer, value: string): Buffer {
  const chunks = parseRiff(webp)
  if (!chunks) return webp
  let vp8x = chunks.find((c) => c.fourcc === 'VP8X')
  if (!vp8x) {
    const info = simpleImageInfo(chunks)
    if (!info) return webp
    vp8x = vp8xChunk(info)
    chunks.unshift(vp8x)
  }
  if (vp8x.data.length < 10) return webp
  const flags = Buffer.from(vp8x.data)
  flags[0] |= VP8X_XMP
  vp8x.data = flags

  const existing = chunks.find((c) => c.fourcc === 'XMP ')
  if (existing) {
    // 이미 XMP가 있으면(NAI 등) 지우지 않고 우리 설명만 더한다
    const xml = existing.data.toString('utf8')
    const close = xml.lastIndexOf('</rdf:RDF>')
    if (close < 0) return webp
    existing.data = Buffer.from(
      xml.slice(0, close) + xmpDescription(value) + xml.slice(close),
      'utf8'
    )
  } else {
    // XMP는 이미지·EXIF 뒤, 마지막 청크 자리
    chunks.push({ fourcc: 'XMP ', data: Buffer.from(xmpPacket(value), 'utf8') })
  }
  return writeRiff(chunks)
}
