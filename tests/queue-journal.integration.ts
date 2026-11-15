import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb, initDb } from '../src/main/db'
import { GenerationQueue } from '../src/main/queue/generation-queue'
import { sqliteQueueJournal } from '../src/main/queue/queue-journal'
import {
  bindSceneReservationRecovery,
  createScene,
  deleteScene,
  enqueueReservedScenes,
  getScene,
  reservedTotal,
  setSceneReserves
} from '../src/main/scenes/repo'
import type { GenerationRequest } from '../src/shared/types'

const environment = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => environment.directory, getLocale: () => 'ko' },
  BrowserWindow: {},
  dialog: {}
}))

const request = {
  prompt: 'base',
  negativePrompt: '',
  width: 832,
  height: 1216,
  seed: 7
} as GenerationRequest

/** Never settles unless aborted — the state a forced quit leaves the queue in */
function hangingGeneration(
  _request: GenerationRequest,
  _id: string,
  signal: AbortSignal
): Promise<string> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
      once: true
    })
  })
}

const unbind: (() => void)[] = []
/** A queue as the app builds it on start: journal-backed, with reservation recovery bound */
function startQueue(generate: ConstructorParameters<typeof GenerationQueue>[0]): GenerationQueue {
  const queue = new GenerationQueue(generate)
  queue.setJournal(sqliteQueueJournal(getDb))
  queue.setDelayMs(0)
  unbind.push(bindSceneReservationRecovery(queue, () => {}))
  return queue
}

function journalRows(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM queue_journal').get() as { n: number }).n
}
function sourceRows(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM queue_journal_sources').get() as { n: number })
    .n
}

beforeEach(() => {
  environment.directory = mkdtempSync(join(tmpdir(), 'nais3-queue-journal-'))
  initDb()
})
afterEach(() => {
  unbind.splice(0).forEach((off) => off())
  closeDb()
  rmSync(environment.directory, { recursive: true, force: true })
})

describe('queue journal', () => {
  it('keeps unfinished generations across a forced quit and resumes them in order', async () => {
    const crashed = startQueue(hangingGeneration)
    crashed.enqueue(request, 3)
    expect(journalRows()).toBe(3)
    const before = crashed.status().items.map((item) => [item.id, item.request.seed])

    // Next start: the previous process is gone without cleaning up.
    unbind.splice(0).forEach((off) => off())
    const unfinished = sqliteQueueJournal(getDb).load()
    expect(unfinished.map((item) => [item.id, item.request.seed])).toEqual(before)
    expect(unfinished.every((item) => item.state === 'pending')).toBe(true)

    const seen: number[] = []
    const queue = startQueue(async (req) => {
      seen.push(req.seed)
      return '/image.png'
    })
    queue.restore(unfinished, true)
    await vi.waitFor(() => expect(queue.status().running).toBe(false))
    expect(seen).toEqual([7, 8, 9])
    expect(journalRows()).toBe(0)
  })

  it('gives scene reservations back when the restored generations are discarded', () => {
    const sceneId = createScene(1, 'Scene')
    setSceneReserves(sceneId, { '': 2, 'cast-a': 1 })
    const crashed = startQueue(hangingGeneration)
    enqueueReservedScenes(crashed, {
      casts: [
        { castId: '', request },
        { castId: 'cast-a', request }
      ],
      seedLocked: true
    })
    // The handoff took the reservations off the scene and journaled them in one transaction.
    expect(reservedTotal()).toBe(0)
    expect(journalRows()).toBe(3)

    unbind.splice(0).forEach((off) => off())
    const queue = startQueue(hangingGeneration)
    queue.restore(sqliteQueueJournal(getDb).load(), false)
    expect(getScene(sceneId)?.reserves).toEqual({ '': 2, 'cast-a': 1 })
    expect(journalRows()).toBe(0)
    expect(queue.status().running).toBe(false)
  })

  it('stores a shared i2i source once and drops it with its last item', async () => {
    const source = { imageBase64: 'aW1hZ2U=', strength: 0.5, noise: 0 }
    const withSource = { ...request, source } as GenerationRequest
    const crashed = startQueue(hangingGeneration)
    crashed.enqueue(withSource, 3)
    expect(sourceRows()).toBe(1)
    const stored = getDb().prepare('SELECT request_json FROM queue_journal').all() as {
      request_json: string
    }[]
    expect(stored.every((row) => !row.request_json.includes('aW1hZ2U='))).toBe(true)

    unbind.splice(0).forEach((off) => off())
    const unfinished = sqliteQueueJournal(getDb).load()
    expect(unfinished.map((item) => item.request.source)).toEqual([source, source, source])

    const queue = startQueue(async () => '/image.png')
    queue.restore(unfinished, true)
    await vi.waitFor(() => expect(queue.status().running).toBe(false))
    expect(journalRows()).toBe(0)
    expect(sourceRows()).toBe(0)
  })

  it('removes items that finish, fail or are cancelled', async () => {
    let call = 0
    const queue = startQueue(async () => {
      call++
      if (call === 2) throw new Error('bad request')
      return '/image.png'
    })
    queue.enqueue(request, 3)
    await vi.waitFor(() => expect(queue.status().running).toBe(false))
    expect(journalRows()).toBe(0)

    const stuck = startQueue(hangingGeneration)
    stuck.enqueue(request, 2)
    await stuck.cancelAll(1000)
    expect(stuck.status().running).toBe(false)
    expect(journalRows()).toBe(0)
  })

  it('forgets a deleted scene so a resumed item cannot save into a reused scene ID', () => {
    const sceneId = createScene(1, 'Deleted')
    setSceneReserves(sceneId, { '': 1 })
    const crashed = startQueue(hangingGeneration)
    enqueueReservedScenes(crashed, { casts: [{ castId: '', request }], seedLocked: true })
    expect(crashed.status().items[0].state).toBe('generating')
    deleteScene(sceneId)

    unbind.splice(0).forEach((off) => off())
    const [item] = sqliteQueueJournal(getDb).load()
    expect(item.request.sceneId).toBeUndefined()
    expect(item.reservation).toBeUndefined()
  })

  it('drops unreadable rows instead of failing the start', () => {
    getDb()
      .prepare(
        "INSERT INTO queue_journal (item_id, request_json, source_id) VALUES ('a', '{', NULL), ('b', '{}', 'missing')"
      )
      .run()
    expect(sqliteQueueJournal(getDb).load()).toEqual([])
    expect(journalRows()).toBe(0)
  })
})
