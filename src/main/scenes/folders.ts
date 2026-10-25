import { existsSync } from 'fs'
import { getDb } from '../db'
import { sceneSourceDirs } from '../db/media'
import { sceneFolderInfo, sceneWriteDir } from '../images/storage'

/**
 * 씬 폴더 해석 — 쓰기 위치 하나, 읽기 위치 여럿.
 * - 쓰기: 지금 씬 루트의 UUID 폴더(새 씬), 기존 씬은 이름 폴더 그대로 (storage.ts sceneWriteDir)
 * - 읽기: scene_sources — 출력을 쓴 폴더를 파일마다 귀속한다. 이전 씬 루트, 이름을 바꾸기 전 폴더,
 *   여러 씬이 함께 쓰던 옛 이름 폴더(그 폴더에 파일이 있는 씬마다)
 */
export interface SceneFolders {
  write: string
  read: string[]
}

export function sceneFolders(sceneId: number): SceneFolders | null {
  const scene = sceneFolderInfo(sceneId)
  if (!scene) return null
  const write = sceneWriteDir(scene)
  const read = sceneSourceDirs(getDb(), sceneId)
    .map((source) => source.path)
    .filter((path, i, all) => path !== write && all.indexOf(path) === i)
  return { write, read }
}

/**
 * "폴더 열기" 대상 — 쓰기 폴더가 있으면 그것, 아직 없으면(첫 생성 전, 씬 루트를 바꾼 뒤) 마지막으로
 * 쓴 순서대로 있는 읽기 폴더. 어디에도 없으면 null
 */
export function sceneFolderToOpen(sceneId: number): string | null {
  const folders = sceneFolders(sceneId)
  if (!folders) return null
  return [folders.write, ...folders.read].find((dir) => existsSync(dir)) ?? null
}
