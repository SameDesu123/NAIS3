import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { measurePath, measurePaths, pathsOverlap, samePath } from '../src/main/storage/usage'
import { formatBytes } from '../src/renderer/src/lib/format-bytes'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nais3-storage-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('measurePath', () => {
  it('sums files in nested folders', async () => {
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    writeFileSync(join(root, 'one.png'), Buffer.alloc(10))
    writeFileSync(join(root, 'a', 'two.png'), Buffer.alloc(20))
    writeFileSync(join(root, 'a', 'b', 'three.png'), Buffer.alloc(30))

    expect(await measurePath(root)).toEqual({
      bytes: 60,
      files: 3,
      exists: true,
      incomplete: false
    })
  })

  it('reports a missing path without failing', async () => {
    expect(await measurePath(join(root, 'missing'))).toEqual({
      bytes: 0,
      files: 0,
      exists: false,
      incomplete: false
    })
  })

  it('does not follow links inside the measured folder', async () => {
    const outside = join(root, 'outside')
    const measured = join(root, 'measured')
    mkdirSync(outside)
    mkdirSync(measured)
    writeFileSync(join(outside, 'big.png'), Buffer.alloc(100))
    writeFileSync(join(measured, 'small.png'), Buffer.alloc(5))
    symlinkSync(outside, join(measured, 'link'), 'junction')
    symlinkSync(measured, join(measured, 'loop'), 'junction')

    const usage = await measurePath(measured)
    expect(usage.bytes).toBe(5)
    expect(usage.files).toBe(1)
  })

  it('skips excluded folders so nested save folders are not counted twice', async () => {
    const main = join(root, 'out')
    const scene = join(main, 'scene')
    mkdirSync(scene, { recursive: true })
    writeFileSync(join(main, 'main.png'), Buffer.alloc(7))
    writeFileSync(join(scene, 'scene.png'), Buffer.alloc(11))

    expect((await measurePath(main, undefined, [scene])).bytes).toBe(7)
    expect(
      (await measurePath(main, undefined, [join(root, 'x', '..', 'out', 'scene')])).bytes
    ).toBe(7)
    expect((await measurePath(scene, undefined, [main])).bytes).toBe(11)
  })

  it('stops when the scan is aborted', async () => {
    writeFileSync(join(root, 'one.png'), Buffer.alloc(1))
    const controller = new AbortController()
    controller.abort()
    await expect(measurePath(root, controller.signal)).rejects.toThrow()
  })

  it('combines a database file with its WAL companions', async () => {
    const db = join(root, 'nais3.db')
    writeFileSync(db, Buffer.alloc(4096))
    writeFileSync(`${db}-wal`, Buffer.alloc(1024))

    expect(await measurePaths([db, `${db}-wal`, `${db}-shm`])).toEqual({
      bytes: 5120,
      files: 2,
      exists: true,
      incomplete: false
    })
  })
})

describe('save folder overlap', () => {
  it('detects identical and nested folders', () => {
    const main = join(root, 'out')
    expect(samePath(main, join(root, 'x', '..', 'out'))).toBe(true)
    expect(pathsOverlap(main, main)).toBe(true)
    expect(pathsOverlap(main, join(main, 'scene'))).toBe(true)
    expect(pathsOverlap(join(main, 'scene'), main)).toBe(true)
    expect(pathsOverlap(main, join(root, 'out-scene'))).toBe(false)
    expect(samePath(main, join(main, 'scene'))).toBe(false)
  })
})

describe('formatBytes', () => {
  it('uses binary units with a locale-aware format', () => {
    expect(formatBytes(512, 'en')).toBe('512 byte')
    expect(formatBytes(1536, 'en')).toBe('1.5 kB')
    expect(formatBytes(25 * 1024 * 1024, 'en')).toBe('25 MB')
    expect(formatBytes(3.25 * 1024 ** 3, 'en')).toBe('3.3 GB')
  })
})
