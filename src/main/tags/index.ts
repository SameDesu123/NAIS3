import type Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import workerPath from './build.worker?modulePath'
import { ensureTagsDb, findTagsSource } from './cache'
import { openTagsDb, searchTagsDb, type TagEntry } from './store'

/**
 * 단부루 태그 자동완성 데이터 (resources/tags.json, 게시물 10건 이상).
 * NAIS2는 이걸 렌더러 번들에 넣었지만, NAIS3는 메인에서 IPC 검색으로 서빙
 * — 렌더러 메모리/번들에 대용량 데이터를 싣지 않는다.
 *
 * 메인도 JSON을 힙에 들고 있지 않는다: 첫 검색 때 userData/tags-cache/에 읽기 전용 SQLite를
 * 만들어 두고(cache.ts) 인덱스로 조회한다. 사용자 DB(db/)와 분리 — 백업·마이그레이션 대상이 아니다.
 */

export type { TagEntry }

let db: Database.Database | null = null
let opening: Promise<Database.Database> | null = null

function open(): Promise<Database.Database> {
  opening ??= ensureTagsDb(
    findTagsSource(join(app.getAppPath(), 'resources')),
    join(app.getPath('userData'), 'tags-cache'),
    workerPath
  )
    .then((path) => (db = openTagsDb(path)))
    .catch((error) => {
      opening = null // 다음 검색에서 다시 시도
      throw error
    })
  return opening
}

export async function searchTags(query: string, limit = 8): Promise<TagEntry[]> {
  try {
    return searchTagsDb(db ?? (await open()), query, limit)
  } catch (error) {
    // 자동완성은 부가 기능 — 실패해도 입력을 막지 않는다
    console.error('Tag search failed:', error)
    return []
  }
}
