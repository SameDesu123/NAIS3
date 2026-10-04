import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
vi.mock('../src/main/db', () => ({ getDb: () => null }))
vi.mock('../src/main/db/settings', () => ({ getSetting: () => null }))
import { migrations } from '../src/main/db/migrations'
import { metadataFromPayloadJson } from '../src/main/images/metadata'
import { storedPayload } from '../src/main/images/storage'

const heavyPayload = {
  action: 'infill',
  input: 'girl, smile',
  model: 'nai-diffusion-4-5-full-inpainting',
  parameters: {
    width: 832,
    height: 1216,
    steps: 28,
    seed: 42,
    negative_prompt: 'lowres',
    image: 'A'.repeat(4096),
    mask: 'B'.repeat(4096),
    director_reference_images: ['C'.repeat(4096)],
    reference_image_multiple: ['D'.repeat(4096)],
    reference_strength_multiple: [0.6]
  }
}

describe('storedPayload', () => {
  it('drops base64 image fields but keeps generation parameters', () => {
    const stored = JSON.parse(storedPayload(JSON.stringify(heavyPayload)))
    expect(stored.parameters).not.toHaveProperty('image')
    expect(stored.parameters).not.toHaveProperty('mask')
    expect(stored.parameters).not.toHaveProperty('director_reference_images')
    expect(stored.parameters).not.toHaveProperty('reference_image_multiple')
    expect(stored.parameters.reference_strength_multiple).toEqual([0.6])
    expect(stored.input).toBe('girl, smile')
    expect(metadataFromPayloadJson(JSON.stringify(stored))).toEqual(
      metadataFromPayloadJson(JSON.stringify(heavyPayload))
    )
  })

  it('attaches local metadata and leaves light payloads untouched', () => {
    const light = JSON.stringify({ input: 'x', parameters: { steps: 28 } })
    expect(storedPayload(light)).toBe(light)
    expect(storedPayload('{"local":"mosaic"}')).toBe('{"local":"mosaic"}')
    expect(storedPayload('not json')).toBe('not json')
    const promptParts = { base: 'a', additional: 'b', detail: 'c' }
    const stored = JSON.parse(storedPayload(JSON.stringify(heavyPayload), { promptParts }))
    expect(stored.nais3).toEqual({ promptParts })
    expect(stored.parameters).not.toHaveProperty('image')
  })
})

describe('v19 payload cleanup migration', () => {
  it('strips image fields from existing history rows only', () => {
    const db = new Database(':memory:')
    try {
      for (let v = 0; v < 18; v++) migrations[v](db)
      const insert = db.prepare('INSERT INTO images (id, file_path, payload_json) VALUES (?, ?, ?)')
      insert.run(1, '/a.png', JSON.stringify(heavyPayload))
      insert.run(2, '/b.png', '{"input":"saved"}')
      insert.run(3, '/c.png', 'not json')
      migrations[18](db)
      const rows = db.prepare('SELECT id, payload_json FROM images ORDER BY id').all() as {
        id: number
        payload_json: string
      }[]
      const cleaned = JSON.parse(rows[0].payload_json)
      expect(cleaned.parameters).toEqual({
        width: 832,
        height: 1216,
        steps: 28,
        seed: 42,
        negative_prompt: 'lowres',
        reference_strength_multiple: [0.6]
      })
      expect(cleaned.input).toBe('girl, smile')
      expect(rows[1].payload_json).toBe('{"input":"saved"}')
      expect(rows[2].payload_json).toBe('not json')
    } finally {
      db.close()
    }
  })
})
