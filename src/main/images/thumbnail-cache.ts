import { createHash, randomUUID } from 'crypto'
import { app } from 'electron'
import type { Stats } from 'fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import sharp from '../sharp'

/**
 * 출력 이미지 썸네일 캐시 — 메모리 LRU + 디스크(userData/nais-cache).
 * 원본 파일의 경로·mtime·크기로 키를 잡으니 파일이 밖에서 바뀌면 키가 바뀌어 다시 만든다.
 * 언제 통째로 지워도 잃는 것이 없다 — 다음 요청 때 원본에서 다시 만든다.
 *
 * 폴더 이름은 'cache'가 아니다: userData에는 Chromium의 'Cache'가 이미 있고,
 * macOS·Windows는 대소문자를 가리지 않아 같은 폴더가 된다.
 */

// 썸네일 규격이 바뀌면 이 값을 바꿔 옛 캐시를 버린다
const THUMBNAIL_SPEC = '640-webp90'
const MEMORY_BUDGET = 48 * 1024 * 1024
// 원본 디코드는 무겁다 — 첫 화면에 타일이 몰려도 메인 프로세스가 버티게 동시에 두 장만
const MAX_RENDERS = 2
const RENDER_TIMEOUT = 30_000

export function cacheRoot(): string {
  return join(app.getPath('userData'), 'nais-cache')
}

/** 카드가 커질 수 있어 640px로 (화질 열화 방지). webp q90 — 저장 시 DB 썸네일과 같은 규격 */
export function renderThumbnail(input: Buffer): Promise<Buffer> {
  return sharp(input).resize(640, 640, { fit: 'inside' }).webp({ quality: 90 }).toBuffer()
}

/** 원본 파일 하나의 버전 — 이 값이 같으면 캐시된 썸네일을 그대로 쓴다 */
export interface SourceVersion {
  path: string
  mtimeMs: number
  size: number
}

export function sourceVersion(path: string, st: Stats): SourceVersion {
  return { path: path.normalize('NFC'), mtimeMs: Math.floor(st.mtimeMs), size: st.size }
}

export function sameVersion(a: SourceVersion | null | undefined, b: SourceVersion): boolean {
  return !!a && a.path === b.path && a.mtimeMs === b.mtimeMs && a.size === b.size
}

function versionKey(v: SourceVersion): string {
  return createHash('sha1')
    .update(`${THUMBNAIL_SPEC}\0${v.path}\0${v.mtimeMs}\0${v.size}`)
    .digest('hex')
}

function thumbnailFile(key: string): string {
  return join(cacheRoot(), 'thumbs', key.slice(0, 2), `${key}.webp`)
}

// ── 메모리 LRU (바이트 상한) ─────────────────────────────
const memory = new Map<string, Buffer>()
let memoryBytes = 0

export function memoryGet(key: string): Buffer | undefined {
  const hit = memory.get(key)
  if (hit) {
    memory.delete(key)
    memory.set(key, hit)
  }
  return hit
}

export function memorySet(key: string, value: Buffer): void {
  const old = memory.get(key)
  if (old) memoryBytes -= old.length
  memory.delete(key)
  memory.set(key, value)
  memoryBytes += value.length
  for (const [k, v] of memory) {
    if (memoryBytes <= MEMORY_BUDGET) break
    memory.delete(k)
    memoryBytes -= v.length
  }
}

/** 메모리 캐시만 비운다 (테스트·디스크 캐시를 지운 뒤) */
export function clearMemoryCache(): void {
  memory.clear()
  memoryBytes = 0
}

// ── 디스크 ──────────────────────────────────────────────
export async function readCacheFile(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file)
  } catch {
    return null
  }
}

/** 임시 파일에 쓰고 rename — 반쯤 쓴 파일이 캐시로 읽히지 않게. 실패는 삼킨다 (캐시일 뿐) */
export async function writeCacheFile(file: string, data: Buffer | string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(tmp, data)
    await rename(tmp, file)
  } catch {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

let renders = 0
const waiting: (() => void)[] = []

/**
 * 동시에 MAX_RENDERS장만 디코드한다. 끝난 자리는 줄 선 다음 작업에 바로 넘긴다 —
 * 비웠다가 다시 잡으면 그 사이에 새 요청이 끼어들어 상한을 넘는다.
 * 디코드가 실패하든 RENDER_TIMEOUT 안에 끝나지 않든 자리는 반드시 돌려준다:
 * 한 장이 멈췄다고 그 뒤의 썸네일이 모두 멈추면 안 된다 (호출부는 DB 썸네일로 폴백).
 */
async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (renders < MAX_RENDERS) renders++
  else await new Promise<void>((resolve) => waiting.push(resolve))
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('thumbnail render timed out')), RENDER_TIMEOUT)
      })
    ])
  } finally {
    clearTimeout(timer)
    const next = waiting.shift()
    if (next) next()
    else renders--
  }
}

const inflight = new Map<string, Promise<Buffer | null>>()

/**
 * 원본 파일의 썸네일. 메모리 → 디스크 → 원본 디코드 순.
 * 파일이 없거나 읽을 수 없으면 null — 호출부가 DB 썸네일로 폴백한다.
 * seed: 원본을 디코드하지 않고 쓸 수 있는 같은 픽셀의 썸네일 (저장 직후 DB 썸네일 등)
 */
export async function thumbnailForFile(
  path: string,
  seed?: (version: SourceVersion) => Buffer | null
): Promise<Buffer | null> {
  let st: Stats
  try {
    st = await stat(path)
  } catch {
    return null
  }
  if (!st.isFile()) return null
  const version = sourceVersion(path, st)
  const key = versionKey(version)
  const hit = memoryGet(key)
  if (hit) return hit
  const running = inflight.get(key)
  if (running) return running

  // 같은 파일을 기다리는 요청이 모두 이 약속을 공유한다 — 무슨 일이 있어도 값으로 끝나야 한다
  const task = (async (): Promise<Buffer | null> => {
    try {
      const file = thumbnailFile(key)
      let thumb = await readCacheFile(file)
      if (!thumb) {
        thumb =
          seed?.(version) ?? (await limited(async () => renderThumbnail(await readFile(path))))
        await writeCacheFile(file, thumb)
      }
      memorySet(key, thumb)
      return thumb
    } catch {
      return null
    }
  })()
  inflight.set(key, task)
  try {
    return await task
  } finally {
    inflight.delete(key)
  }
}

/** 방금 저장한 파일의 썸네일을 캐시에 넣는다 — 생성 직후 카드가 원본을 다시 디코드하지 않게 */
export async function primeThumbnail(path: string, thumb: Buffer): Promise<void> {
  try {
    const key = versionKey(sourceVersion(path, await stat(path)))
    memorySet(key, thumb)
    await writeCacheFile(thumbnailFile(key), thumb)
  } catch {
    // 캐시일 뿐 — 다음 요청 때 원본에서 만든다
  }
}
