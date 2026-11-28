import type Database from 'better-sqlite3'

/**
 * 히스토리·라이브러리 검색 색인. 원본 테이블(images, library_images)과 백업 형식은 건드리지 않고,
 * 파생 테이블만 둔다 — 지워도 백필이 다시 만든다. 그래서 스키마 버전을 올리지 않고 매 실행
 * IF NOT EXISTS로 보장한다 (마이그레이션 워커·업그레이드 백업이 필요 없다).
 *
 * - *_search_meta: 필터 열(kind·모델·시드·시각) + 정규화 텍스트. images의 thumbnail BLOB 뒤에 있는
 *   열을 훑으면 오버플로 페이지까지 읽게 되므로 따로 둔다.
 * - *_search_fts: meta를 content로 쓰는 FTS5 (트리거로 동기화).
 * - 원본 행이 지워지면 트리거가 meta를 지운다. 원본에 FK를 걸지 않는 이유: 백업 복원이
 *   원본을 통째로 DELETE·INSERT하는데, 그 사이 FK 동작에 끼어들지 않게.
 */
const SEARCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS image_search_meta (
  image_id INTEGER PRIMARY KEY,
  kind TEXT,
  model_id TEXT,
  seed INTEGER,
  created_at TEXT NOT NULL DEFAULT '',
  prompt_text TEXT NOT NULL DEFAULT '',
  artist_text TEXT NOT NULL DEFAULT '',
  character_text TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_image_search_kind ON image_search_meta(kind, image_id);
CREATE INDEX IF NOT EXISTS idx_image_search_model ON image_search_meta(model_id, image_id);
CREATE INDEX IF NOT EXISTS idx_image_search_seed ON image_search_meta(seed);
CREATE INDEX IF NOT EXISTS idx_image_search_created ON image_search_meta(created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS image_search_fts USING fts5(
  prompt_text, artist_text, character_text,
  content='image_search_meta', content_rowid='image_id'
);
CREATE TRIGGER IF NOT EXISTS trg_image_search_meta_ai AFTER INSERT ON image_search_meta BEGIN
  INSERT INTO image_search_fts(rowid, prompt_text, artist_text, character_text)
  VALUES (new.image_id, new.prompt_text, new.artist_text, new.character_text);
END;
CREATE TRIGGER IF NOT EXISTS trg_image_search_meta_ad AFTER DELETE ON image_search_meta BEGIN
  INSERT INTO image_search_fts(image_search_fts, rowid, prompt_text, artist_text, character_text)
  VALUES ('delete', old.image_id, old.prompt_text, old.artist_text, old.character_text);
END;
CREATE TRIGGER IF NOT EXISTS trg_image_search_meta_au AFTER UPDATE ON image_search_meta BEGIN
  INSERT INTO image_search_fts(image_search_fts, rowid, prompt_text, artist_text, character_text)
  VALUES ('delete', old.image_id, old.prompt_text, old.artist_text, old.character_text);
  INSERT INTO image_search_fts(rowid, prompt_text, artist_text, character_text)
  VALUES (new.image_id, new.prompt_text, new.artist_text, new.character_text);
END;
CREATE TRIGGER IF NOT EXISTS trg_images_ad_search AFTER DELETE ON images BEGIN
  DELETE FROM image_search_meta WHERE image_id = old.id;
END;

CREATE TABLE IF NOT EXISTS library_search_meta (
  library_image_id INTEGER PRIMARY KEY,
  kind TEXT,
  model_id TEXT,
  seed INTEGER,
  created_at TEXT NOT NULL DEFAULT '',
  name_text TEXT NOT NULL DEFAULT '',
  prompt_text TEXT NOT NULL DEFAULT '',
  artist_text TEXT NOT NULL DEFAULT '',
  character_text TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_library_search_model ON library_search_meta(model_id);
CREATE INDEX IF NOT EXISTS idx_library_search_seed ON library_search_meta(seed);

CREATE VIRTUAL TABLE IF NOT EXISTS library_search_fts USING fts5(
  name_text, prompt_text, artist_text, character_text,
  content='library_search_meta', content_rowid='library_image_id'
);
CREATE TRIGGER IF NOT EXISTS trg_library_search_meta_ai AFTER INSERT ON library_search_meta BEGIN
  INSERT INTO library_search_fts(rowid, name_text, prompt_text, artist_text, character_text)
  VALUES (new.library_image_id, new.name_text, new.prompt_text, new.artist_text, new.character_text);
END;
CREATE TRIGGER IF NOT EXISTS trg_library_search_meta_ad AFTER DELETE ON library_search_meta BEGIN
  INSERT INTO library_search_fts(library_search_fts, rowid, name_text, prompt_text, artist_text, character_text)
  VALUES ('delete', old.library_image_id, old.name_text, old.prompt_text, old.artist_text, old.character_text);
END;
CREATE TRIGGER IF NOT EXISTS trg_library_search_meta_au AFTER UPDATE ON library_search_meta BEGIN
  INSERT INTO library_search_fts(library_search_fts, rowid, name_text, prompt_text, artist_text, character_text)
  VALUES ('delete', old.library_image_id, old.name_text, old.prompt_text, old.artist_text, old.character_text);
  INSERT INTO library_search_fts(rowid, name_text, prompt_text, artist_text, character_text)
  VALUES (new.library_image_id, new.name_text, new.prompt_text, new.artist_text, new.character_text);
END;
CREATE TRIGGER IF NOT EXISTS trg_library_images_ad_search AFTER DELETE ON library_images BEGIN
  DELETE FROM library_search_meta WHERE library_image_id = old.id;
END;
`

/** 검색 색인 테이블·트리거 보장 (멱등). 마이그레이션이 끝난 연결에서 부른다 */
export function ensureSearchSchema(db: Database.Database): void {
  db.exec(SEARCH_SCHEMA)
}

/** 색인을 비운다 — 다음 백필이 처음부터 다시 만든다 (테스트·복구용) */
export function resetSearchIndex(db: Database.Database): void {
  db.transaction(() => {
    db.prepare('DELETE FROM image_search_meta').run()
    db.prepare('DELETE FROM library_search_meta').run()
    db.prepare("INSERT INTO image_search_fts(image_search_fts) VALUES ('rebuild')").run()
    db.prepare("INSERT INTO library_search_fts(library_search_fts) VALUES ('rebuild')").run()
  })()
}
