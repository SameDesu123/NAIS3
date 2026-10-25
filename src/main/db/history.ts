import type Database from 'better-sqlite3'

// electron에 의존하지 않는다 — 마이그레이션 워커의 한 번짜리 작업(ensure.ts)도 쓴다

/**
 * 히스토리 상태는 순번(seq)으로만 바꾼다. 지우기는 media_hidden에 숨김을 남기고, 비우기는
 * history_state.cleared_seq를 올린다 — images 행·파일·씬 갤러리는 그대로다.
 * 숨김의 scope는 서로 독립: 히스토리에서 숨겨도 씬 갤러리엔 보이고, 그 반대도 같다.
 */
export type HiddenScope = 'history' | 'scene'

/** 히스토리에 보이는 images 행 (FROM images에 별칭 없이) */
export const HISTORY_VISIBLE = `images.seq > (SELECT cleared_seq FROM history_state WHERE id = 1)
  AND NOT EXISTS (SELECT 1 FROM media_hidden h WHERE h.seq = images.seq AND h.scope = 'history')`

/** 씬 갤러리에 보이는 행. seq가 없는 행도 보인다 — 씬은 순번과 무관하다 */
export function sceneVisible(alias = 'images'): string {
  return `NOT EXISTS (SELECT 1 FROM media_hidden h WHERE h.seq = ${alias}.seq AND h.scope = 'scene')`
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

/** images 행들을 한 scope에서 숨긴다. 이미 숨긴 행은 그대로 */
export function hideImages(db: Database.Database, ids: number[], scope: HiddenScope): void {
  if (ids.length === 0) return
  db.transaction(() => {
    if (hasMissingSeqs(db)) assignMissingSeqs(db)
    const hide = db.prepare(
      'INSERT OR IGNORE INTO media_hidden (seq, scope) SELECT seq, ? FROM images WHERE id = ?'
    )
    for (const id of ids) hide.run(scope, id)
  })()
}

/** 히스토리 비우기 — 지금까지 배정된 순번을 모두 경계 아래로 (반환: 비우기 전 보이던 수) */
export function clearHistory(db: Database.Database): number {
  return db.transaction(() => {
    const count = db
      .prepare(`SELECT COUNT(*) FROM images WHERE ${HISTORY_VISIBLE}`)
      .pluck()
      .get() as number
    db.prepare('UPDATE history_state SET cleared_seq = next_seq - 1 WHERE id = 1').run()
    return count
  })()
}
