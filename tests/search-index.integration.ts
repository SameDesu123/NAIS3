import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrations } from '../src/main/db/migrations'
import { ensureSearchSchema } from '../src/main/search/schema'
import {
  buildSearchWhere,
  HISTORY_SCOPE,
  LIBRARY_SCOPE,
  searchFacets
} from '../src/main/search/query'
import { searchDocumentFromPayload, type SearchDocument } from '../src/shared/search-extract'
import { compileSearchFilter } from '../src/shared/search-query'
import type { ImageSearchFilter } from '../src/shared/types'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  for (const migrate of migrations) migrate(db)
  ensureSearchSchema(db)
})

afterEach(() => {
  db.close()
})

function upsertImageMeta(id: number, doc: SearchDocument, createdAt: string): void {
  db.prepare(
    `INSERT INTO image_search_meta
       (image_id, kind, model_id, seed, created_at, prompt_text, artist_text, character_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(image_id) DO UPDATE SET
       kind = excluded.kind, model_id = excluded.model_id, seed = excluded.seed,
       created_at = excluded.created_at, prompt_text = excluded.prompt_text,
       artist_text = excluded.artist_text, character_text = excluded.character_text`
  ).run(
    id,
    doc.kind,
    doc.modelId,
    doc.seed,
    createdAt,
    doc.promptText,
    doc.artistText,
    doc.characterText
  )
}

function addImage(input: {
  kind: string
  seed: number
  prompt: string
  model: string
  characterNames?: string[]
  createdAt?: string
  favorite?: boolean
}): number {
  const createdAt = input.createdAt ?? '2026-03-05 12:00:00'
  const payload = JSON.stringify({
    input: input.prompt,
    model: input.model,
    parameters: { seed: input.seed },
    nais3: { characterNames: input.characterNames ?? [] }
  })
  const id = Number(
    db
      .prepare(
        'INSERT INTO images (file_path, kind, seed, payload_json, created_at, favorite) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        `/out/${input.seed}.png`,
        input.kind,
        input.seed,
        payload,
        createdAt,
        input.favorite ? 1 : 0
      ).lastInsertRowid
  )
  upsertImageMeta(
    id,
    searchDocumentFromPayload(payload, { kind: input.kind, seed: input.seed }),
    createdAt
  )
  return id
}

function findHistory(filter: ImageSearchFilter): number[] {
  const search = compileSearchFilter(filter)
  if (!search) throw new Error('expected an active filter')
  const where = buildSearchWhere(db, HISTORY_SCOPE, search)
  return db
    .prepare(`SELECT m.image_id FROM image_search_meta m WHERE ${where.sql} ORDER BY m.image_id`)
    .pluck()
    .all(...where.params) as number[]
}

describe('search index schema', () => {
  it('can be ensured again on every start', () => {
    expect(() => ensureSearchSchema(db)).not.toThrow()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE '%search%' ORDER BY name")
      .pluck()
      .all()
    expect(tables).toEqual(
      expect.arrayContaining([
        'image_search_meta',
        'image_search_fts',
        'library_search_meta',
        'library_search_fts'
      ])
    )
  })
})

describe('history search', () => {
  let blue: number
  let medium: number
  let mosaic: number
  let korean: number

  beforeEach(() => {
    blue = addImage({
      kind: 't2i',
      seed: 1111111,
      prompt: '1girl, artist:wlop, blue_eyes, long hair',
      model: 'nai-diffusion-5-full',
      favorite: true
    })
    medium = addImage({
      kind: 'inpaint',
      seed: 2222222,
      prompt: '1girl, artist:mika pikazo, red eyes, short hair',
      model: 'nai-diffusion-5-full-medium-inpainting',
      createdAt: '2026-03-07 09:00:00'
    })
    mosaic = addImage({ kind: 'mosaic', seed: 3333333, prompt: '', model: '' })
    korean = addImage({
      kind: 'scene',
      seed: 4444444,
      prompt: 'scenery, night sky',
      model: 'nai-diffusion-4-5-curated',
      characterNames: ['아리스']
    })
  })

  it('finds keywords as prefix phrases and applies exclusions', () => {
    expect(findHistory({ query: 'blue eye' })).toEqual([blue])
    expect(findHistory({ query: '"blue eye"' })).toEqual([blue])
    expect(findHistory({ query: '1girl -long' })).toEqual([medium])
    expect(findHistory({ query: 'hair -red' })).toEqual([blue])
  })

  it('searches artists and non-ASCII character names in their own fields', () => {
    expect(findHistory({ query: 'artist:wlop' })).toEqual([blue])
    expect(findHistory({ artists: ['mika_pikazo'] })).toEqual([medium])
    expect(findHistory({ query: 'artist:hair' })).toEqual([])
    expect(findHistory({ query: 'char:아리스' })).toEqual([korean])
    expect(findHistory({ query: '리스' })).toEqual([korean])
    expect(findHistory({ query: '-char:아리스' })).toEqual([blue, medium, mosaic])
  })

  it('keeps V5 Full and V5 Full Medium apart', () => {
    expect(findHistory({ models: ['nai-diffusion-5-full'] })).toEqual([blue])
    expect(findHistory({ models: ['nai-diffusion-5-full-medium'] })).toEqual([medium])
    // 모델을 모르는 행은 제외 조건에 걸리지 않는다
    expect(findHistory({ query: '-model:v5' })).toEqual([medium, mosaic, korean])
  })

  it('filters kind groups, seeds, dates and favorites', () => {
    expect(findHistory({ kinds: ['director'] })).toEqual([mosaic])
    expect(findHistory({ query: '-kind:director' })).toEqual([blue, medium, korean])
    expect(findHistory({ seed: 2222222 })).toEqual([medium])
    expect(findHistory({ query: '3333333' })).toEqual([mosaic])
    expect(
      findHistory({ dateFromUtc: '2026-03-06 00:00:00', dateToUtc: '2026-03-07 23:59:59' })
    ).toEqual([medium])
    expect(findHistory({ favoritesOnly: true })).toEqual([blue])
    db.prepare('UPDATE images SET favorite = 1 WHERE id = ?').run(korean)
    expect(findHistory({ favoritesOnly: true })).toEqual([blue, korean])
  })

  it('keeps the full-text index in step with updates and deletes', () => {
    upsertImageMeta(
      blue,
      searchDocumentFromPayload(JSON.stringify({ input: 'green eyes' }), {
        kind: 't2i',
        seed: 1111111
      }),
      '2026-03-05 12:00:00'
    )
    expect(findHistory({ query: 'blue' })).toEqual([])
    expect(findHistory({ query: 'green' })).toEqual([blue])

    db.prepare('DELETE FROM images WHERE id = ?').run(medium)
    expect(
      db.prepare('SELECT COUNT(*) FROM image_search_meta WHERE image_id = ?').pluck().get(medium)
    ).toBe(0)
    expect(findHistory({ query: 'red' })).toEqual([])
    expect(
      db
        .prepare("SELECT COUNT(*) FROM image_search_fts WHERE image_search_fts MATCH 'red'")
        .pluck()
        .get()
    ).toBe(0)
  })

  it('counts facets by model, kind group and artist', () => {
    const facets = searchFacets(db, 'history')
    expect(facets.models).toEqual(
      expect.arrayContaining([
        { value: 'nai-diffusion-5-full', count: 1 },
        { value: 'nai-diffusion-5-full-medium', count: 1 },
        { value: 'nai-diffusion-4-5-curated', count: 1 }
      ])
    )
    expect(facets.kinds).toEqual(expect.arrayContaining([{ value: 'director', count: 1 }]))
    expect(facets.topArtists.map((a) => a.value).sort()).toEqual(['mika_pikazo', 'wlop'])
  })
})

describe('library search', () => {
  it('matches file names, prompts and stack names', () => {
    const stack = Number(
      db.prepare("INSERT INTO library_stacks (name) VALUES ('Cover Candidates')").run()
        .lastInsertRowid
    )
    const insert = db.prepare(
      'INSERT INTO library_images (name, file_path, stack_id, created_at) VALUES (?, ?, ?, ?)'
    )
    const meta = db.prepare(
      `INSERT INTO library_search_meta
         (library_image_id, kind, model_id, seed, created_at, name_text, prompt_text, artist_text,
          character_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const add = (name: string, prompt: string, stackId: number | null): number => {
      const id = Number(
        insert.run(name, `/lib/${name}`, stackId, '2026-03-05 12:00:00').lastInsertRowid
      )
      const doc = searchDocumentFromPayload(JSON.stringify({ input: prompt }), {
        kind: null,
        seed: null,
        name
      })
      meta.run(
        id,
        doc.kind,
        doc.modelId,
        doc.seed,
        '2026-03-05 12:00:00',
        doc.nameText,
        doc.promptText,
        doc.artistText,
        doc.characterText
      )
      return id
    }
    const stacked = add('sky.png', 'night sky', stack)
    const loose = add('cover_draft.png', 'portrait', null)

    const find = (query: string): number[] => {
      const search = compileSearchFilter({ query })
      if (!search) throw new Error('expected an active filter')
      const where = buildSearchWhere(db, LIBRARY_SCOPE, search)
      return db
        .prepare(
          `SELECT m.library_image_id FROM library_search_meta m WHERE ${where.sql} ORDER BY m.library_image_id`
        )
        .pluck()
        .all(...where.params) as number[]
    }

    expect(find('sky')).toEqual([stacked])
    expect(find('cover')).toEqual([stacked, loose])
    expect(find('candidates')).toEqual([stacked])
    expect(find('portrait -candidates')).toEqual([loose])

    db.prepare('DELETE FROM library_images WHERE id = ?').run(stacked)
    expect(db.prepare('SELECT COUNT(*) FROM library_search_meta').pluck().get()).toBe(1)
  })
})
