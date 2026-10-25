import type Database from 'better-sqlite3'

/**
 * user_version을 올리지 않는 추가 전용 스키마 (v20 위에 쌓는다).
 *
 * 번호 마이그레이션은 버전을 올릴 때마다 다운그레이드를 막는다. 테이블·nullable 컬럼·인덱스처럼
 * 옛 앱이 몰라도 되는 변경은 여기에 선언해, user_version 20 그대로 1.0.29로 내려가도 같은 DB를 연다.
 *
 * 규칙:
 * - 추가만 한다. 기존 컬럼의 의미·제약은 바꾸지 않고, 새 컬럼은 NULL 허용이나 기본값을 둔다 —
 *   옛 앱의 INSERT는 새 컬럼을 모른다.
 * - 각 항목은 적용 여부를 스스로 판정한다. 몇 번을 실행해도 결과가 같다.
 * - 시드·데이터 수리는 넣지 않는다. 한 번만 돌아야 하는 데이터 작업은 oneTimeJobs에 둔다.
 * - 새 영속 상태는 모두 nais3.db에 둔다 — 자동 DB 스냅샷(VACUUM INTO)이 그대로 담는다.
 * - 옛 앱에서 지워질 수 있는 images 행에는 외래 키를 걸지 않는다 (H에서 images를 없앤다).
 */
export interface EnsureStep {
  name: string
  isApplied(db: Database.Database): boolean
  apply(db: Database.Database): void
}

function hasObject(db: Database.Database, type: 'table' | 'index', name: string): boolean {
  return (
    db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name) !==
    undefined
  )
}

function table(name: string, sql: string): EnsureStep {
  return {
    name: `table ${name}`,
    isApplied: (db) => hasObject(db, 'table', name),
    apply: (db) => db.exec(sql)
  }
}

function index(name: string, sql: string): EnsureStep {
  return {
    name: `index ${name}`,
    isApplied: (db) => hasObject(db, 'index', name),
    apply: (db) => db.exec(sql)
  }
}

function column(tableName: string, columnName: string, definition: string): EnsureStep {
  return {
    name: `column ${tableName}.${columnName}`,
    isApplied: (db) =>
      (db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[]).some(
        (row) => row.name === columnName
      ),
    apply: (db) => db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
  }
}

/** 순서대로 적용한다 — 외래 키가 가리키는 테이블이 먼저 */
export const ensureSteps: EnsureStep[] = [
  // 한 번만 도는 데이터 작업의 완료 표시. 이름이 있으면 다시 돌리지 않는다
  table(
    'applied_jobs',
    `CREATE TABLE applied_jobs (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ),

  // 미디어 루트 — 출력이 놓이는 폴더. 파일 위치는 (root_id, 원문 상대 경로)로 가리킨다.
  // 저장 폴더 설정을 바꾸면 새 루트를 등록한다. 기존 root_id의 경로를 바꾸는 것은
  // 사용자가 그 폴더를 실제로 옮겼을 때(재연결)뿐이다.
  // - path: OS가 준 원문 절대 경로. path_key: NFC 정규화한 조회 키 — 유일하지 않다
  //   (NFC/NFD를 구분하는 파일시스템에서는 다른 폴더일 수 있다). 충돌은 병합하지 않고 보고한다
  // - kind: output(메인 저장) · scene(씬 저장) · external(밖에서 끌어온 이미지의 NAIS 소유 복사본)
  // - status: current(지금 저장하는 곳) · past(이전 저장 폴더) · unmapped(다른 기기의 백업에서
  //   복원돼 이 기기 경로와 아직 연결되지 않음 — 활성 루트로 쓰지 않는다)
  // - in_history: 히스토리에 보이는지. 이전 루트는 히스토리를 비울 때까지만 남는다
  table(
    'media_roots',
    `CREATE TABLE media_roots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('output', 'scene', 'external')),
      path TEXT NOT NULL UNIQUE,
      path_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'past', 'unmapped')),
      in_history INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ),
  index(
    'idx_media_roots_path_key',
    'CREATE INDEX idx_media_roots_path_key ON media_roots(path_key)'
  ),

  // 히스토리 상태 (한 행). 등록 순번 seq는 출력을 커밋하는 트랜잭션에서 next_seq로 배정한다.
  // 히스토리 비우기는 cleared_seq를 그때의 마지막 seq로 올릴 뿐 — 행·파일·씬은 건드리지 않는다
  table(
    'history_state',
    `CREATE TABLE history_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      next_seq INTEGER NOT NULL DEFAULT 1,
      cleared_seq INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO history_state (id) VALUES (1)`
  ),

  // 등록된 미디어 원장 — 생성 출력·외부 복사본·수동 추가·재인덱싱으로 히스토리에 들어온 파일.
  // 파일의 존재·내용·파라미터는 파일이 진실이고, 여기엔 위치와 순번만 둔다.
  // seq는 항상 history_state.next_seq로 넣는다 (rowid 자동 배정에 맡기면 images.seq와 겹칠 수 있다).
  // scene_id: 그 파일이 속한 씬 (같은 폴더를 여러 레거시 씬이 공유할 수 있어 폴더가 아니라 파일로 귀속)
  table(
    'media_registrations',
    `CREATE TABLE media_registrations (
      seq INTEGER PRIMARY KEY,
      root_id INTEGER NOT NULL REFERENCES media_roots(id),
      rel_path TEXT NOT NULL,
      path_key TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('generated', 'external', 'manual', 'reindex', 'reclaim')),
      scene_id INTEGER REFERENCES gen_scenes(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (root_id, rel_path)
    )`
  ),
  index(
    'idx_media_registrations_path_key',
    'CREATE INDEX idx_media_registrations_path_key ON media_registrations(root_id, path_key)'
  ),
  index(
    'idx_media_registrations_scene',
    'CREATE INDEX idx_media_registrations_scene ON media_registrations(scene_id, seq)'
  ),

  // 숨김 — 지우기의 기본 동작. 파일은 그대로 두고 seq를 숨긴다.
  // scope가 다르면 서로 영향이 없다: 히스토리에서 숨겨도 씬 갤러리엔 보이고, 그 반대도 같다.
  // seq는 images.seq(H 전 히스토리 행)나 media_registrations.seq에 있어 외래 키를 걸지 않는다.
  // 둘 다 history_state.next_seq에서 배정하므로 겹치지 않는다
  table(
    'media_hidden',
    `CREATE TABLE media_hidden (
      seq INTEGER NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('history', 'scene')),
      hidden_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (seq, scope)
    )`
  ),

  // 씬별 저장 위치 — 새 파일을 쓸 곳(write) 하나와 갤러리를 읽을 곳(read) 여럿
  // (이전 저장 루트, 다운그레이드 중 옛 앱이 만든 이름 폴더). rel_dir ''은 루트 자체.
  // 씬이 지워지면(복원으로 gen_scenes가 바뀔 때 포함) 함께 지워진다
  table(
    'scene_sources',
    `CREATE TABLE scene_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scene_id INTEGER NOT NULL REFERENCES gen_scenes(id) ON DELETE CASCADE,
      root_id INTEGER NOT NULL REFERENCES media_roots(id),
      rel_dir TEXT NOT NULL,
      dir_key TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'read' CHECK (role IN ('write', 'read')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (scene_id, root_id, rel_dir)
    )`
  ),
  index(
    'idx_scene_sources_scene',
    'CREATE INDEX idx_scene_sources_scene ON scene_sources(scene_id, role)'
  ),

  // 새 씬의 UUID 폴더 이름 (<씬 루트>/<uuid>/). 표시 이름은 gen_scenes.name 그대로.
  // NULL = 기존 이름 폴더. 저장에 쓰기 시작하는 것은 E — 여기선 컬럼만 둔다
  column('gen_scenes', 'folder_uuid', 'TEXT'),
  index(
    'idx_gen_scenes_folder_uuid',
    'CREATE UNIQUE INDEX idx_gen_scenes_folder_uuid ON gen_scenes(folder_uuid) WHERE folder_uuid IS NOT NULL'
  ),

  // 기존 히스토리 행의 등록 순번 (H 전까지). NULL = 아직 순번 없음 — 옛 앱이 넣은 행 포함.
  // 배정은 A+1의 몫
  column('images', 'seq', 'INTEGER')
]

/**
 * 한 번만 도는 데이터 작업. 각 작업은 자기 IMMEDIATE 트랜잭션에서 돌고 applied_jobs에 남는다.
 * name은 바꾸지 않는다 (바꾸면 다시 돈다). 백업 파일 이름에도 쓰이므로 [a-z0-9-]만.
 * 디렉터리 순회처럼 오래 걸리거나 반복해야 하는 일은 여기가 아니다 (트랜잭션 밖에서)
 */
export interface OneTimeJob {
  name: string
  run(db: Database.Database): void
}

export const oneTimeJobs: OneTimeJob[] = []

export function pendingEnsureSteps(db: Database.Database): EnsureStep[] {
  return ensureSteps.filter((step) => !step.isApplied(db))
}

export function isJobApplied(db: Database.Database, name: string): boolean {
  if (!hasObject(db, 'table', 'applied_jobs')) return false
  return db.prepare('SELECT 1 FROM applied_jobs WHERE name = ?').get(name) !== undefined
}

export function pendingJobs(db: Database.Database): OneTimeJob[] {
  return oneTimeJobs.filter((job) => !isJobApplied(db, job.name))
}
