import { createHash } from 'crypto'
import type Database from 'better-sqlite3'
import type { GenerationRequest, QueueItem, SceneReservation } from '../../shared/types'

/**
 * Unfinished queue items kept on disk. The queue lives in memory, so without this a crash,
 * forced quit or power loss drops every pending generation — and the scene reservations that
 * were already handed to it. Rows exist only while an item is pending or generating.
 */
export interface QueueJournal {
  /** Persists new items. `commit` (the reservation handoff) runs in the same transaction. */
  add(items: readonly QueueItem[], commit?: () => void): void
  /** Rewrites the request and reservation of items that are still unfinished */
  update(items: readonly QueueItem[]): void
  remove(ids: readonly string[]): void
}

export interface SqliteQueueJournal extends QueueJournal {
  /** Items the previous run left unfinished, in queue order */
  load(): QueueItem[]
}

type Source = NonNullable<GenerationRequest['source']>

interface Row {
  item_id: string
  request_json: string
  source_id: string | null
  reservation_json: string | null
}

/**
 * i2i/inpaint sources are several MB of base64 and a batch shares one source object,
 * so each distinct source is stored once (keyed by its content hash) and referenced by rows.
 */
export function sqliteQueueJournal(getDb: () => Database.Database): SqliteQueueJournal {
  const sourceIds = new WeakMap<Source, string>()

  /** Hashes a source once per object; `onSerialized` receives the JSON when it was just built */
  function sourceId(source: Source, onSerialized?: (id: string, json: string) => void): string {
    let id = sourceIds.get(source)
    if (!id) {
      const json = JSON.stringify(source)
      id = createHash('sha256').update(json).digest('hex')
      sourceIds.set(source, id)
      onSerialized?.(id, json)
    }
    return id
  }

  function columns(
    item: QueueItem,
    onSerialized?: (id: string, json: string) => void
  ): {
    request: string
    source: string | null
    reservation: string | null
  } {
    const request: GenerationRequest = { ...item.request }
    delete request.source
    return {
      request: JSON.stringify(request),
      source: item.request.source ? sourceId(item.request.source, onSerialized) : null,
      reservation: item.reservation ? JSON.stringify(item.reservation) : null
    }
  }

  function pruneSources(db: Database.Database): void {
    db.prepare(
      `DELETE FROM queue_journal_sources
       WHERE id NOT IN (SELECT source_id FROM queue_journal WHERE source_id IS NOT NULL)`
    ).run()
  }

  return {
    add(items, commit) {
      const db = getDb()
      const hasSource = db.prepare('SELECT 1 FROM queue_journal_sources WHERE id = ?')
      const insertSource = db.prepare(
        'INSERT INTO queue_journal_sources (id, source_json) VALUES (?, ?)'
      )
      const insertItem = db.prepare(
        `INSERT OR REPLACE INTO queue_journal (item_id, request_json, source_id, reservation_json)
         VALUES (?, ?, ?, ?)`
      )
      db.transaction(() => {
        const written = new Set<string>()
        for (const item of items) {
          let json: string | undefined
          const row = columns(item, (_id, serialized) => (json = serialized))
          if (row.source && !written.has(row.source)) {
            // A source seen earlier may have been pruned once its items finished
            if (!hasSource.get(row.source)) {
              insertSource.run(row.source, json ?? JSON.stringify(item.request.source))
            }
            written.add(row.source)
          }
          insertItem.run(item.id, row.request, row.source, row.reservation)
        }
        commit?.()
      })()
    },

    update(items) {
      const db = getDb()
      const updateItem = db.prepare(
        'UPDATE queue_journal SET request_json = ?, reservation_json = ? WHERE item_id = ?'
      )
      db.transaction(() => {
        for (const item of items) {
          const row = columns(item)
          updateItem.run(row.request, row.reservation, item.id)
        }
      })()
    },

    remove(ids) {
      if (ids.length === 0) return
      const db = getDb()
      const removeItem = db.prepare('DELETE FROM queue_journal WHERE item_id = ?')
      db.transaction(() => {
        for (const id of ids) removeItem.run(id)
        pruneSources(db)
      })()
    },

    load() {
      const db = getDb()
      const rows = db
        .prepare(
          'SELECT item_id, request_json, source_id, reservation_json FROM queue_journal ORDER BY id'
        )
        .all() as Row[]
      const getSource = db.prepare('SELECT source_json FROM queue_journal_sources WHERE id = ?')
      const sources = new Map<string, Source | null>()
      const items: QueueItem[] = []
      const broken: string[] = []
      for (const row of rows) {
        try {
          const request = JSON.parse(row.request_json) as GenerationRequest
          if (row.source_id) {
            if (!sources.has(row.source_id)) {
              const stored = getSource.get(row.source_id) as { source_json: string } | undefined
              sources.set(row.source_id, stored ? (JSON.parse(stored.source_json) as Source) : null)
            }
            const source = sources.get(row.source_id)
            // Without its source an i2i/inpaint request would silently turn into t2i
            if (!source) throw new Error('missing source')
            request.source = source
          }
          const reservation = row.reservation_json
            ? (JSON.parse(row.reservation_json) as SceneReservation)
            : undefined
          items.push({
            id: row.item_id,
            state: 'pending',
            request,
            ...(reservation ? { reservation } : {})
          })
        } catch (error) {
          console.error('Dropping an unreadable journaled generation:', error)
          broken.push(row.item_id)
        }
      }
      if (broken.length > 0) this.remove(broken)
      return items
    }
  }
}
