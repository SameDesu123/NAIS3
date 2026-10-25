import type Database from 'better-sqlite3'

// electron에 의존하지 않는다 — 마이그레이션 워커의 한 번짜리 작업(ensure.ts)도 쓴다

/**
 * 히스토리 상태는 순번(seq)으로만 바꾼다. 지우기는 media_hidden에 숨김을 남기고, 비우기는
 * history_state.cleared_seq를 올린다 — images 행·파일·씬 갤러리는 그대로다.
 * 숨김의 scope는 서로 독립: 히스토리에서 숨겨도 씬 갤러리엔 보이고, 그 반대도 같다.
 */
export type HiddenScope = 'history' | 'scene'

/** 씬 갤러리에 보이는 행. seq가 없는 행도 보인다 — 씬은 순번과 무관하다 */
export function sceneVisible(alias = 'images'): string {
  return `NOT EXISTS (SELECT 1 FROM media_hidden h WHERE h.seq = ${alias}.seq AND h.scope = 'scene')`
}

/**
 * 히스토리 항목 = 원장 등록(media_registrations) ∪ images 행, 순번(seq)이 정체성이다 — 같은 출력은
 * 같은 seq라 겹치지 않는다(reclaim이 행의 순번으로 등록한다). 다른 기기에서 복원해 온(unmapped)
 * 루트의 등록은 이 기기에서 읽을 수 없어 빠진다. images 행은 memory://, 루트 밖 파일, 아직 등록되지
 * 않은 옛 행을 덮는다. 오프라인 루트의 등록은 남는다 — 목록·수에서 빼지 않는다
 */
const REGISTERED_HISTORY = `FROM media_registrations r JOIN media_roots ro ON ro.id = r.root_id
  WHERE r.seq > @cleared AND r.seq < @before AND ro.status != 'unmapped'
    AND NOT EXISTS (SELECT 1 FROM media_hidden h WHERE h.seq = r.seq AND h.scope = 'history')`
const IMAGE_HISTORY = `FROM images WHERE images.seq > @cleared AND images.seq < @before
    AND NOT EXISTS (SELECT 1 FROM media_hidden h WHERE h.seq = images.seq AND h.scope = 'history')`

/** 히스토리 한 페이지의 순번 — 실행 계획을 테스트가 확인한다 (임시 B-tree 정렬이 없어야 한다) */
export const HISTORY_PAGE_SQL = `SELECT r.seq AS seq ${REGISTERED_HISTORY}
  UNION
  SELECT images.seq ${IMAGE_HISTORY}
  ORDER BY seq DESC LIMIT @limit OFFSET @offset`

export function historyParams(
  db: Database.Database,
  before?: number
): { cleared: number; before: number } {
  const cleared = db
    .prepare('SELECT cleared_seq FROM history_state WHERE id = 1')
    .pluck()
    .get() as number
  return { cleared, before: before ?? Number.MAX_SAFE_INTEGER }
}

/**
 * 히스토리 한 페이지의 순번 (최신부터). before를 주면 그보다 오래된 것부터 (키셋 페이징).
 * 두 쪽 모두 seq 인덱스 순서로 읽어 합친다 — 임시 정렬이 없어 원장이 커도 첫 페이지가 빠르다
 */
export function historySeqs(
  db: Database.Database,
  page: { limit: number; offset?: number; before?: number }
): number[] {
  return db
    .prepare(HISTORY_PAGE_SQL)
    .pluck()
    .all({
      ...historyParams(db, page.before),
      limit: page.limit,
      offset: page.offset ?? 0
    }) as number[]
}

/** 히스토리 항목 수 — 등록 수 + 등록되지 않은 행 수 (합집합을 만들지 않고 인덱스로 센다) */
export function historyCount(db: Database.Database): number {
  return db
    .prepare(
      `SELECT (SELECT COUNT(*) ${REGISTERED_HISTORY})
            + (SELECT COUNT(*) ${IMAGE_HISTORY}
               AND NOT EXISTS (
                 SELECT 1 FROM media_registrations r JOIN media_roots ro ON ro.id = r.root_id
                 WHERE r.seq = images.seq AND ro.status != 'unmapped'
               ))`
    )
    .pluck()
    .get(historyParams(db)) as number
}

/** 순번들을 한 scope에서 숨긴다. 이미 숨긴 순번은 그대로 */
export function hideSeqs(db: Database.Database, seqs: number[], scope: HiddenScope): void {
  if (seqs.length === 0) return
  const hide = db.prepare('INSERT OR IGNORE INTO media_hidden (seq, scope) VALUES (?, ?)')
  db.transaction(() => {
    for (const seq of seqs) hide.run(seq, scope)
  })()
}

/** 순번 하나를 배정한다 — 출력 행을 넣는 같은 트랜잭션에서 불러야 비우기 경계가 지켜진다 */
export function allocateSeq(db: Database.Database): number {
  return db
    .prepare('UPDATE history_state SET next_seq = next_seq + 1 WHERE id = 1 RETURNING next_seq - 1')
    .pluck()
    .get() as number
}

/**
 * 순번이 없는 images 행에 id 순서대로 배정한다 (반환: 배정한 행 수).
 * 처음 한 번은 기존 행 전부 (한 번짜리 작업 assign-image-seq), 그 뒤로는 다운그레이드한 옛 앱이
 * 넣은 행만 남는다 — 매 실행 다시 불러도 할 일이 없으면 아무것도 바꾸지 않는다.
 * next_seq는 남아 있는 가장 큰 seq보다 항상 크게 맞춘다 (UNIQUE 인덱스와 충돌하지 않도록)
 */
export function assignMissingSeqs(db: Database.Database): number {
  const ids = db.prepare('SELECT id FROM images WHERE seq IS NULL ORDER BY id').pluck().all()
  db.prepare(
    `UPDATE history_state
     SET next_seq = MAX(
       next_seq,
       (SELECT COALESCE(MAX(seq), 0) + 1 FROM images),
       (SELECT COALESCE(MAX(seq), 0) + 1 FROM media_registrations)
     )
     WHERE id = 1`
  ).run()
  if (ids.length === 0) return 0
  const update = db.prepare('UPDATE images SET seq = ? WHERE id = ?')
  for (const id of ids) update.run(allocateSeq(db), id)
  return ids.length
}

export function hasMissingSeqs(db: Database.Database): boolean {
  return db.prepare('SELECT 1 FROM images WHERE seq IS NULL LIMIT 1').get() !== undefined
}

/**
 * 순번이 없는 행이 있으면 지금 배정한다 — 다운그레이드한 옛 앱이 이번 실행 중에 넣은 행이라도
 * 순번으로 가리킬 수 있게 (순번이 항목의 정체성이다)
 */
export function ensureSeqs(db: Database.Database): void {
  if (!hasMissingSeqs(db)) return
  db.transaction(() => assignMissingSeqs(db))()
}

/** images 행들을 한 scope에서 숨긴다. 이미 숨긴 행은 그대로 */
export function hideImages(db: Database.Database, ids: number[], scope: HiddenScope): void {
  if (ids.length === 0) return
  db.transaction(() => {
    ensureSeqs(db)
    const hide = db.prepare(
      'INSERT OR IGNORE INTO media_hidden (seq, scope) SELECT seq, ? FROM images WHERE id = ?'
    )
    for (const id of ids) hide.run(scope, id)
  })()
}

/** 히스토리 비우기 — 지금까지 배정된 순번을 모두 경계 아래로 (반환: 비우기 전 보이던 수) */
export function clearHistory(db: Database.Database): number {
  return db.transaction(() => {
    const count = historyCount(db)
    db.prepare('UPDATE history_state SET cleared_seq = next_seq - 1 WHERE id = 1').run()
    return count
  })()
}
