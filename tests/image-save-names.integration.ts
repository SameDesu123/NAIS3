import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb } from '../src/main/db'
import { saveGeneratedImage } from '../src/main/images/storage'
import sharp from '../src/main/sharp'

const environment = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => environment.directory, getName: () => 'NAIS3', getLocale: () => 'en-US' },
  BrowserWindow: {},
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => false }
}))

function pixel(color: string): Promise<Buffer> {
  return sharp({ create: { width: 1, height: 1, channels: 3, background: color } })
    .png()
    .toBuffer()
}

describe('saveGeneratedImage file names', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nais3-image-save-names-'))
    environment.directory = root
    initDb()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-28T12:34:56.100Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    closeDb()
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps both originals when two seed-0 saves land in the same second', async () => {
    const first = await pixel('#ff0000')
    const second = await pixel('#0000ff')

    const a = await saveGeneratedImage({ png: first, sentPayload: '{}', seed: 0, kind: 'mosaic' })
    vi.setSystemTime(new Date('2026-10-28T12:34:56.900Z'))
    const b = await saveGeneratedImage({ png: second, sentPayload: '{}', seed: 0, kind: 'upscale' })

    expect(basename(a.filePath)).toBe('NAIS3_2026-10-28T12-34-56_0.png')
    expect(basename(b.filePath)).toBe('NAIS3_2026-10-28T12-34-56_0_2.png')
    expect(readFileSync(a.filePath).equals(first)).toBe(true)
    expect(readFileSync(b.filePath).equals(second)).toBe(true)
    const paths = getDb().prepare('SELECT file_path FROM images ORDER BY id').pluck().all()
    expect(paths).toEqual([a.filePath, b.filePath])
  })

  it('does not overwrite when concurrent saves pick the same name', async () => {
    const pngs = await Promise.all(['#ff0000', '#00ff00', '#0000ff'].map(pixel))

    const saved = await Promise.all(
      pngs.map((png) => saveGeneratedImage({ png, sentPayload: '{}', seed: 0, kind: 'mosaic' }))
    )

    expect(new Set(saved.map((s) => s.filePath)).size).toBe(3)
    saved.forEach((s, i) => expect(readFileSync(s.filePath).equals(pngs[i])).toBe(true))
  })

  it('continues scene numbering after the files already in the folder', async () => {
    const first = await saveGeneratedImage({
      png: await pixel('#ff0000'),
      sentPayload: '{}',
      seed: 1,
      kind: 'scene',
      sceneName: 'Beach'
    })
    const squatter = join(dirname(first.filePath), 'Beach_2.png')
    writeFileSync(squatter, 'not an image')

    const next = await saveGeneratedImage({
      png: await pixel('#0000ff'),
      sentPayload: '{}',
      seed: 2,
      kind: 'scene',
      sceneName: 'Beach'
    })

    expect(basename(next.filePath)).toBe('Beach_3.png')
    expect(readFileSync(squatter, 'utf8')).toBe('not an image')
  })
})
