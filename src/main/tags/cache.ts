import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import {
  buildTagsDb,
  hashFile,
  TAGS_DB_SCHEMA,
  type TagsBuildWorkerData,
  type TagsBuildWorkerMessage
} from './store'

// electron에 의존하지 않는다 — 경로는 tags/index.ts가 넘긴다 (테스트에서 그대로 쓰려고)

/** 원본 tags.json(.gz) 위치. 압축본이 있으면 그쪽 — 배포본을 gzip으로 바꿔도 그대로 동작 */
export function findTagsSource(resourceDir: string): string {
  const gz = join(resourceDir, 'tags.json.gz')
  return existsSync(gz) ? gz : join(resourceDir, 'tags.json')
}

/**
 * 캐시 DB 경로를 돌려준다. 없으면 만든다.
 *
 * 파일 이름에 스키마 버전과 원본 해시를 넣는다 — 앱 업데이트로 tags.json이 바뀌면 이름이 달라져
 * 새로 만들고, 이전 파일은 지운다. rename으로만 생기는 파일이라 "있으면 완성본"이다.
 */
export async function ensureTagsDb(
  source: string,
  cacheDir: string,
  workerFile?: string
): Promise<string> {
  const hash = await hashFile(source)
  const name = `tags-v${TAGS_DB_SCHEMA}-${hash.slice(0, 16)}.db`
  const destination = join(cacheDir, name)
  mkdirSync(cacheDir, { recursive: true })
  // 이전 버전 캐시와 생성 도중 강제 종료로 남은 .tmp 정리
  for (const f of readdirSync(cacheDir)) {
    if (f !== name && f.startsWith('tags-')) rmSync(join(cacheDir, f), { force: true })
  }
  if (existsSync(destination)) return destination

  const data: TagsBuildWorkerData = { source, destination }
  if (!workerFile || !(await buildInWorker(workerFile, data))) buildTagsDb(source, destination)
  return destination
}

/**
 * 생성(JSON 파싱 + 32만 행 삽입, ~1초)은 워커에서 — 메인 스레드가 막히지 않고, 파싱한 18MB
 * 배열도 워커 힙에만 있다가 워커와 함께 사라진다.
 * 워커를 아예 돌리지 못했으면 false (호출 쪽이 메인 스레드에서 만든다), 생성 실패는 reject.
 */
function buildInWorker(workerFile: string, workerData: TagsBuildWorkerData): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(workerFile, { workerData })
    } catch (error) {
      console.error('Tags DB worker failed:', error)
      resolve(false)
      return
    }
    worker.once('message', (message: TagsBuildWorkerMessage) => {
      if (message.type === 'done') resolve(true)
      else reject(new Error(message.message))
    })
    worker.once('error', (error) => {
      console.error('Tags DB worker failed:', error)
      resolve(false)
    })
    // 결과를 보내기 전에 끝난 경우만 해당 — 이미 정해진 Promise는 바뀌지 않는다
    worker.once('exit', () => resolve(false))
  })
}
