import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import type { GenerationRequest } from '../src/shared/types'
import { metadataFromImage } from '../src/main/images/metadata'
import {
  buildNaisMetadata,
  embedNaisMetadata,
  readWebpNaisParams,
  reproductionSettings
} from '../src/main/images/nais-metadata'
import { buildGenerateImagePayload } from '../src/main/nai/payload'

const request: GenerationRequest = {
  prompt: '1girl, 은발',
  negativePrompt: 'lowres',
  model: 'nai-diffusion-4-5-full',
  width: 832,
  height: 1216,
  steps: 28,
  cfgScale: 5,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  seed: 1234567890,
  variety: false,
  qualityToggle: false,
  ucPreset: 2,
  characterPrompts: [
    {
      prompt: 'girl, red eyes',
      negativePrompt: 'blue eyes',
      enabled: true,
      center: { x: 0.3, y: 0.5 }
    }
  ],
  useCoords: false
} as GenerationRequest

// 실제 이미지만큼 긴 base64 — 이름을 모르는 필드에 들어와도 걸러져야 한다
const imageData = Buffer.alloc(3000, 7).toString('base64')
const maskData = Buffer.alloc(3000, 8).toString('base64')

function i2iPayload(): string {
  const payload = buildGenerateImagePayload(request, {
    imageFormat: 'png',
    i2i: {
      strength: 0.6,
      noise: 0.1,
      extraNoiseSeed: 1234567889,
      colorCorrect: false,
      imageBase64: imageData,
      maskBase64: maskData
    },
    vibes: [{ strength: 0.7, encodedVibeBase64: imageData }],
    characterReferences: [
      { referenceType: 'character&style', strength: 1, fidelity: 0.8, imageBase64: imageData }
    ]
  })
  return JSON.stringify({ ...payload, future_reference: imageData })
}

function meta(sentPayload: string): ReturnType<typeof buildNaisMetadata> {
  return buildNaisMetadata({
    sentPayload,
    kind: 'inpaint',
    seed: request.seed,
    createdAt: new Date('2026-10-25T03:00:00.000Z'),
    appVersion: '1.0.30',
    mediaId: '00000000-0000-4000-8000-000000000000',
    localMetadata: {
      promptParts: { base: '1girl', additional: '은발', detail: '', negative: 'lowres' }
    }
  })
}

/** NAI가 PNG에 넣는 tEXt 청크 하나 (CRC는 읽는 쪽에서 보지 않는다) */
function withNaiComment(png: Buffer, comment: object): Buffer {
  const data = Buffer.from(`Comment\0${JSON.stringify(comment)}`, 'latin1')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write('tEXt', 4, 'ascii')
  data.copy(chunk, 8)
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)])
}

const pixels = async (image: Buffer): Promise<Buffer> => sharp(image).ensureAlpha().raw().toBuffer()

async function source(): Promise<sharp.Sharp> {
  return sharp({
    create: { width: 24, height: 16, channels: 4, background: { r: 200, g: 40, b: 90, alpha: 0.5 } }
  })
}

describe('reproduction settings', () => {
  it('keeps the settings and drops every piece of image data', () => {
    const settings = reproductionSettings(i2iPayload())!
    const json = JSON.stringify(settings)
    expect(json).not.toContain(imageData)
    expect(json).not.toContain(maskData)
    const parameters = settings.parameters as Record<string, unknown>
    for (const key of ['image', 'mask', 'reference_image_multiple', 'director_reference_images'])
      expect(parameters).not.toHaveProperty(key)
    expect(settings).not.toHaveProperty('future_reference')
    expect(settings).toMatchObject({ action: 'infill', model: request.model })
    expect(parameters).toMatchObject({
      seed: request.seed,
      steps: 28,
      scale: 5,
      sampler: 'k_euler_ancestral',
      width: 832,
      height: 1216,
      negative_prompt: expect.stringContaining('lowres'),
      noise: 0.1,
      inpaintImg2ImgStrength: 0.6,
      reference_strength_multiple: [0.7],
      director_reference_strength_values: [1]
    })
  })

  it('records the identity, kind, seed and creation time', () => {
    expect(meta('{"upscale":4,"model":"x"}')).toEqual({
      app: 'NAIS3',
      version: 2,
      appVersion: '1.0.30',
      kind: 'inpaint',
      seed: request.seed,
      createdAt: '2026-10-25T03:00:00.000Z',
      mediaId: '00000000-0000-4000-8000-000000000000',
      request: { upscale: 4, model: 'x' },
      promptParts: { base: '1girl', additional: '은발', detail: '', negative: 'lowres' }
    })
  })
})

describe('PNG outputs', () => {
  it('adds the metadata without touching pixels or NovelAI chunks, and reads it back first', async () => {
    const png = withNaiComment(await (await source()).png().toBuffer(), {
      prompt: 'from novelai',
      uc: '',
      seed: 1
    })
    const embedded = embedNaisMetadata(png, meta(i2iPayload()))
    expect(await pixels(embedded)).toEqual(await pixels(png))
    expect(embedded.includes(Buffer.from('from novelai'))).toBe(true)

    const read = await metadataFromImage(embedded)
    expect(read).toMatchObject({
      prompt: '1girl, 은발',
      seed: request.seed,
      steps: 28,
      model: request.model,
      software: 'NAIS3',
      promptParts: { base: '1girl', additional: '은발' },
      characterPrompts: [{ prompt: 'girl, red eyes', negativePrompt: 'blue eyes' }]
    })
  })

  it('keeps a long tag-per-line prompt that looks like base64', async () => {
    const long = '1girl\nsolo\nsmile\n'.repeat(80)
    const longRequest = {
      ...request,
      prompt: long,
      negativePrompt: long,
      characterPrompts: [{ ...request.characterPrompts[0], prompt: long, negativePrompt: long }]
    } as GenerationRequest
    const payload = buildGenerateImagePayload(longRequest, { imageFormat: 'png' })
    expect(payload.input).toMatch(/^[A-Za-z0-9\n]{1024,}$/)
    const settings = reproductionSettings(JSON.stringify(payload))!
    expect(settings.input).toBe(payload.input)
    expect(settings.parameters).toEqual(payload.parameters)

    const png = await (await source()).png().toBuffer()
    const embedded = embedNaisMetadata(
      png,
      buildNaisMetadata({
        sentPayload: JSON.stringify(payload),
        kind: 't2i',
        seed: request.seed,
        createdAt: new Date('2026-10-25T03:00:00.000Z')
      })
    )
    expect(await metadataFromImage(embedded)).toMatchObject({
      prompt: payload.input,
      characterPrompts: [{ prompt: expect.stringContaining('1girl\nsolo') }]
    })
  })

  it('still reads NovelAI metadata with the promptParts of an older file', async () => {
    const png = withNaiComment(await (await source()).png().toBuffer(), {
      prompt: 'from novelai',
      uc: 'bad',
      seed: 1,
      steps: 23
    })
    // 1.0.29까지의 nais3-params: {version: 1, promptParts}
    const older = embedNaisMetadata(png, {
      version: 1,
      promptParts: { base: 'a', additional: 'b', detail: '' }
    } as never)
    expect(await metadataFromImage(older)).toMatchObject({
      prompt: 'from novelai',
      seed: 1,
      steps: 23,
      promptParts: { base: 'a', additional: 'b' }
    })
  })

  it('falls back to NovelAI metadata when the file has no generation settings', async () => {
    const png = withNaiComment(await (await source()).png().toBuffer(), { prompt: 'p', uc: '' })
    const upscaled = embedNaisMetadata(png, meta('{"upscale":4,"model":"x"}'))
    expect(await metadataFromImage(upscaled)).toMatchObject({ prompt: 'p' })
  })
})

describe('WebP outputs', () => {
  const cases: [string, () => Promise<Buffer>][] = [
    ['lossy', async () => (await source()).flatten().webp({ quality: 80 }).toBuffer()],
    ['lossless with alpha', async () => (await source()).webp({ lossless: true }).toBuffer()],
    [
      'lossy with alpha (VP8X + ALPH)',
      async () => (await source()).webp({ quality: 80 }).toBuffer()
    ],
    [
      'with EXIF',
      async () =>
        (await source())
          .webp({ quality: 80 })
          .withExif({ IFD0: { Software: 'NovelAI' } })
          .toBuffer()
    ]
  ]

  it.each(cases)('%s: decodes to the same pixels and reads the settings back', async (_, make) => {
    const webp = await make()
    const embedded = embedNaisMetadata(webp, meta(i2iPayload()))
    const before = await sharp(webp).metadata()
    const after = await sharp(embedded).metadata()
    expect(after).toMatchObject({
      format: 'webp',
      width: before.width,
      height: before.height,
      hasAlpha: before.hasAlpha
    })
    expect(Boolean(after.exif)).toBe(Boolean(before.exif))
    expect(await pixels(embedded)).toEqual(await pixels(webp))
    expect(readWebpNaisParams(embedded)).toMatchObject({ app: 'NAIS3', kind: 'inpaint' })
    expect(await metadataFromImage(embedded)).toMatchObject({
      prompt: '1girl, 은발',
      seed: request.seed,
      promptParts: { additional: '은발' }
    })
  })

  it('adds to an XMP packet that is already there instead of replacing it', async () => {
    const xmp =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>NovelAI</dc:creator></rdf:Description>' +
      '</rdf:RDF></x:xmpmeta>'
    const webp = await (await source()).webp({ quality: 80 }).withXmp(xmp).toBuffer()
    const embedded = embedNaisMetadata(webp, meta(i2iPayload()))
    const packet = (await sharp(embedded).metadata()).xmp!.toString('utf8')
    expect(packet).toContain('<dc:creator>NovelAI</dc:creator>')
    expect(readWebpNaisParams(embedded)).toMatchObject({ seed: request.seed })
    expect(await pixels(embedded)).toEqual(await pixels(webp))
  })
})

it('leaves buffers it does not recognise as they are', () => {
  const other = Buffer.from('GIF89a not an output')
  expect(embedNaisMetadata(other, meta('{}'))).toBe(other)
})
