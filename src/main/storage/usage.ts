import type { Dirent, Stats } from 'fs'
import { lstat, readdir, stat } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'
import type { StorageUsageTotal } from '../../shared/types'

/** 한 디렉터리에서 동시에 lstat하는 파일 수 — 큰 폴더도 메인 이벤트 루프를 막지 않게 나눠 기다린다 */
const STAT_BATCH = 64

function emptyTotal(exists: boolean): StorageUsageTotal {
  return { bytes: 0, files: 0, exists, incomplete: false }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * 파일 또는 폴더의 실제 파일 크기 합계.
 * - 시작 경로는 링크라도 따라간다 (사용자가 링크된 폴더를 저장 폴더로 골랐을 수 있다).
 * - 안쪽의 심볼릭 링크·정션은 따라가지 않는다 — 순환과 다른 드라이브 중복 집계를 막는다.
 * - 읽을 수 없는 하위 폴더는 건너뛰고 incomplete로 표시한다. 집계 중 사라진 파일은 무시한다.
 * - exclude의 폴더는 통째로 건너뛴다 (다른 저장 폴더가 안에 있을 때 두 번 세지 않게).
 */
export async function measurePath(
  path: string,
  signal?: AbortSignal,
  exclude: readonly string[] = []
): Promise<StorageUsageTotal> {
  signal?.throwIfAborted()
  let root: Stats
  try {
    root = await stat(path)
  } catch (error) {
    if (isMissing(error)) return emptyTotal(false)
    return { ...emptyTotal(true), incomplete: true }
  }
  if (root.isFile()) return { bytes: root.size, files: 1, exists: true, incomplete: false }
  if (!root.isDirectory()) return emptyTotal(true)

  const total = emptyTotal(true)
  const directories = [path]
  while (directories.length > 0) {
    signal?.throwIfAborted()
    const directory = directories.pop() as string
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (!isMissing(error)) total.incomplete = true
      continue
    }
    const files: string[] = []
    for (const entry of entries) {
      const child = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!exclude.some((excluded) => samePath(excluded, child))) directories.push(child)
      } else if (entry.isFile()) files.push(child)
    }
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      signal?.throwIfAborted()
      const sizes = await Promise.all(
        files.slice(i, i + STAT_BATCH).map(async (file) => {
          try {
            return (await lstat(file)).size
          } catch (error) {
            if (!isMissing(error)) total.incomplete = true
            return null
          }
        })
      )
      for (const size of sizes) {
        if (size === null) continue
        total.bytes += size
        total.files += 1
      }
    }
  }
  return total
}

/** 여러 경로의 합계 (예: DB 본체와 -wal/-shm). 하나라도 있으면 exists */
export async function measurePaths(
  paths: readonly string[],
  signal?: AbortSignal
): Promise<StorageUsageTotal> {
  const total = emptyTotal(false)
  for (const path of paths) {
    const part = await measurePath(path, signal)
    total.bytes += part.bytes
    total.files += part.files
    total.exists ||= part.exists
    total.incomplete ||= part.incomplete
  }
  return total
}

/** 같은 폴더인지 — path.relative 기반이라 Windows의 대소문자·구분자 차이도 같은 폴더로 본다 */
export function samePath(a: string, b: string): boolean {
  return relative(resolve(a), resolve(b)) === ''
}

/** 같은 폴더이거나 한쪽이 다른 쪽 안에 있으면 true — 두 크기를 더하면 같은 파일이 두 번 들어간다 */
export function pathsOverlap(a: string, b: string): boolean {
  const contains = (parent: string, child: string): boolean => {
    const rel = relative(resolve(parent), resolve(child))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
  return contains(a, b) || contains(b, a)
}
