import { deflateSync, gzipSync } from 'zlib'
import { describe, expect, it } from 'vitest'
import sharp from '../src/main/sharp'
import { extractImageMetadata } from '../src/main/images/metadata-core'

const params = {
  prompt: 'a quiet mountain lake',
  uc: 'blurry',
  seed: 123456,
  steps: 28,
  scale: 5,
  width: 832,
  height: 1216,
  v4_prompt: {
    use_coords: true,
    caption: { char_captions: [{ char_caption: 'red coat', centers: [{ x: 0.3, y: 0.5 }] }] }
  },
  v4_negative_prompt: { caption: { char_captions: [{ char_caption: 'hat' }] } }
}
const promptParts = { base: 'lake', additional: 'mountains', detail: 'sunlight' }
const payloadJson = JSON.stringify({
  input: 'DB prompt',
  model: 'nai-diffusion-4-5-full',
  parameters: { ...params, seed: 999 },
  nais3: { promptParts }
})

// Text parsers ignore the CRC; image decoding only sees the untouched PNG in stealth tests.
function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length)
  out.write(type, 4)
  data.copy(out, 8)
  return out
}

async function pngWithChunks(...chunks: Buffer[]): Promise<Buffer> {
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ffffff' } })
    .png()
    .toBuffer()
  return Buffer.concat([png.subarray(0, 33), ...chunks, png.subarray(33)])
}

function text(key: string, value: string): Buffer {
  return chunk('tEXt', Buffer.from(`${key}\0${value}`))
}

describe('image metadata extraction', () => {
  it.each(['tEXt', 'zTXt', 'iTXt'])('preserves parameters from %s comments', async (type) => {
    const json = Buffer.from(JSON.stringify(params))
    const data =
      type === 'tEXt'
        ? Buffer.concat([Buffer.from('Comment\0'), json])
        : type === 'zTXt'
          ? Buffer.concat([Buffer.from('Comment\0\0'), deflateSync(json)])
          : Buffer.concat([Buffer.from('Comment\0\x01\0\0\0'), deflateSync(json)])
    const image = await pngWithChunks(chunk(type, data), text('Source', 'nai-diffusion-4-5-full'))
    const meta = await extractImageMetadata({ image })
    expect(meta).toMatchObject({
      prompt: params.prompt,
      negativePrompt: params.uc,
      seed: params.seed,
      steps: 28,
      cfgScale: 5,
      width: 832,
      height: 1216,
      model: 'nai-diffusion-4-5-full',
      useCoords: true,
      characterPrompts: [{ prompt: 'red coat', negativePrompt: 'hat', center: { x: 0.3, y: 0.5 } }]
    })
  })

  it('extracts stealth metadata from column-major alpha bits', async () => {
    const compressed = gzipSync(
      JSON.stringify({ Comment: JSON.stringify(params), Software: 'NAI' })
    )
    const length = Buffer.alloc(4)
    length.writeUInt32BE(compressed.length * 8)
    const hidden = Buffer.concat([Buffer.from('stealth_pngcomp'), length, compressed])
    const width = 64
    const height = Math.ceil((hidden.length * 8) / width)
    const rgba = Buffer.alloc(width * height * 4, 254)
    for (let i = 0; i < hidden.length * 8; i++) {
      const x = Math.floor(i / height)
      const y = i % height
      rgba[(y * width + x) * 4 + 3] |= (hidden[i >> 3] >> (7 - (i & 7))) & 1
    }
    const image = await sharp(rgba, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer()
    expect(await extractImageMetadata({ image })).toMatchObject({
      prompt: params.prompt,
      negativePrompt: params.uc,
      seed: params.seed,
      software: 'NAI'
    })
  })

  it('decodes external data URLs and merges missing local parts from the DB', async () => {
    const png = await pngWithChunks(text('Comment', JSON.stringify(params)))
    expect(
      await extractImageMetadata({
        image: `data:image/png;base64,${png.toString('base64')}`,
        payloadJson
      })
    ).toMatchObject({ prompt: params.prompt, seed: params.seed, promptParts })
  })

  it('keeps local parts from the PNG ahead of the DB fallback', async () => {
    const local = { base: 'PNG prompt', additional: '', detail: '' }
    const image = await pngWithChunks(
      text('Comment', JSON.stringify(params)),
      text('nais3-params', Buffer.from(JSON.stringify({ promptParts: local })).toString('base64'))
    )
    expect(await extractImageMetadata({ image, payloadJson })).toMatchObject({ promptParts: local })
  })

  it('falls back to DB metadata for expired memory images and images without metadata', async () => {
    const image = await pngWithChunks()
    for (const input of [{ payloadJson }, { image, payloadJson }]) {
      expect(await extractImageMetadata(input)).toMatchObject({
        prompt: 'DB prompt',
        seed: 999,
        promptParts
      })
    }
  })

  it('returns null for malformed images or absent metadata', async () => {
    expect(await extractImageMetadata({ image: Buffer.from('not an image') })).toBeNull()
    expect(await extractImageMetadata({ image: await pngWithChunks() })).toBeNull()
    expect(await extractImageMetadata({ payloadJson: '{' })).toBeNull()
  })
})
