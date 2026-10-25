import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }))

vi.mock('../src/main/db', () => ({ getDb: mocks.getDb }))
vi.mock('../src/main/i18n', () => ({ t: (key: string) => key }))
vi.mock('../src/main/sharp', () => ({
  default: () => ({
    metadata: async () => ({ width: 100, height: 100 }),
    resize: () => ({ png: () => ({ toBuffer: async () => Buffer.from('processed') }) })
  })
}))

import { prepareCharRefs, prepareVibes } from '../src/main/refs/prepare'
import { putVibeEncoding } from '../src/main/refs/vibe-encoding-cache'
import { migrations } from '../src/main/db/migrations'

const MODEL = 'nai-diffusion-4-5-full'
let db: Database.Database
let root: string

beforeEach(() => {
  db = new Database(':memory:')
  for (const migration of migrations) migration(db)
  mocks.getDb.mockReturnValue(db)
  root = mkdtempSync(join(tmpdir(), 'nais3-ref-prepare-'))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(Buffer.from('fresh-encoding')))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  db.close()
  rmSync(root, { recursive: true, force: true })
})

function insertCharRef(id: number, filePath: string): void {
  db.prepare(
    `INSERT INTO charref_images (id, name, file_path, enabled, ref_type, strength, fidelity, sort_order)
     VALUES (?, ?, ?, 1, 'character', 1, 1, ?)`
  ).run(id, `ref-${id}`, filePath, id)
}

function insertVibe(id: number, filePath: string, encoded: string | null = null): void {
  db.prepare(
    `INSERT INTO vibe_images (id, name, file_path, enabled, strength, info_extracted, encoded, encoded_ie, sort_order)
     VALUES (?, ?, ?, 1, 0.6, 1, ?, ?, ?)`
  ).run(id, `vibe-${id}`, filePath, encoded, encoded ? 1 : null, id)
}

describe('preparing references restored without their image file', () => {
  it('skips enabled character references whose file is missing instead of failing', async () => {
    const image = join(root, 'ref.png')
    writeFileSync(image, 'image')
    insertCharRef(1, '')
    insertCharRef(2, join(root, 'gone.png'))
    insertCharRef(3, image)

    const { references, skipped } = await prepareCharRefs()
    expect(skipped).toBe(2)
    expect(references).toHaveLength(1)
    expect(references[0].imageBase64).toBe(Buffer.from('processed').toString('base64'))
    // 레퍼런스 행은 지우지 않는다
    expect(db.prepare('SELECT COUNT(*) AS n FROM charref_images').get()).toEqual({ n: 3 })
  })

  it('keeps a vibe with a cached encoding for the model and skips one with nothing to encode', async () => {
    const cached = putVibeEncoding(null, null, MODEL, 1, 'paid-encoding')
    insertVibe(1, '', cached)
    insertVibe(2, '')

    const { vibes, newlyEncoded, skipped } = await prepareVibes('token', MODEL)
    expect(vibes).toEqual([{ strength: 0.6, encodedVibeBase64: 'paid-encoding' }])
    expect(newlyEncoded).toEqual([])
    expect(skipped).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
    // 유료 인코딩 캐시는 그대로 남는다
    expect(db.prepare('SELECT encoded FROM vibe_images WHERE id = 1').get()).toEqual({
      encoded: cached
    })
  })

  it('skips explicitly reserved references the same way', async () => {
    insertCharRef(1, '')
    insertVibe(2, '')
    expect((await prepareCharRefs([1])).skipped).toBe(1)
    expect((await prepareVibes('token', MODEL, [2])).skipped).toBe(1)
  })
})
