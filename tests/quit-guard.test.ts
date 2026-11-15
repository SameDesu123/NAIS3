import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GenerationQueue } from '../src/main/queue/generation-queue'
import type { QueueJournal } from '../src/main/queue/queue-journal'
import type { GenerationRequest, QueueItem } from '../src/shared/types'

const { showMessageBox, quit } = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  quit: vi.fn()
}))

vi.mock('electron', () => ({
  app: { quit },
  dialog: { showMessageBox }
}))
vi.mock('../src/main/i18n', () => ({
  t: (id: string, ...args: unknown[]) => [id, ...args].join(':')
}))

const { createQuitGuard, offerUnfinishedGenerations } = await import('../src/main/queue/quit-guard')

const win = { isDestroyed: () => false } as BrowserWindow
const REQ = { seed: 1 } as GenerationRequest

function hanging(_r: GenerationRequest, _id: string, signal: AbortSignal): Promise<string> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })
}

function event(): { preventDefault: ReturnType<typeof vi.fn> } {
  return { preventDefault: vi.fn() }
}

beforeEach(() => {
  showMessageBox.mockReset()
  quit.mockReset()
})

describe('quit guard', () => {
  it('lets the quit through when nothing is generating', () => {
    const guard = createQuitGuard()
    guard.setQueue(new GenerationQueue(async () => '/a.png'))
    const e = event()
    guard.guard(e, win)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('stops the quit and keeps generating by default', async () => {
    const queue = new GenerationQueue(hanging)
    queue.enqueue(REQ, 2)
    const guard = createQuitGuard()
    guard.setQueue(queue)
    showMessageBox.mockResolvedValue({ response: 0 })
    const e = event()
    guard.guard(e, win)
    expect(e.preventDefault).toHaveBeenCalled()
    // A second close while the prompt is open does not open another one
    guard.guard(event(), win)
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledTimes(1))
    const [parent, options] = showMessageBox.mock.calls[0]
    expect(parent).toBe(win)
    expect(options).toMatchObject({
      detail: 'ui.quitWhileGeneratingDetail:2',
      defaultId: 0,
      cancelId: 0
    })
    await Promise.resolve()
    expect(quit).not.toHaveBeenCalled()
    expect(queue.unfinishedCount()).toBe(2)
  })

  it('quits without cancelling when the user resumes next time, then stops asking', async () => {
    const queue = new GenerationQueue(hanging)
    queue.enqueue(REQ, 2)
    const guard = createQuitGuard()
    guard.setQueue(queue)
    showMessageBox.mockResolvedValue({ response: 1 })
    guard.guard(event(), win)
    await vi.waitFor(() => expect(quit).toHaveBeenCalled())
    expect(queue.unfinishedCount()).toBe(2)
    const again = event()
    guard.guard(again, win)
    expect(again.preventDefault).not.toHaveBeenCalled()
  })

  it('cancels everything, including the request in flight, before quitting', async () => {
    const queue = new GenerationQueue(hanging)
    queue.enqueue(REQ, 3)
    const guard = createQuitGuard()
    guard.setQueue(queue)
    showMessageBox.mockResolvedValue({ response: 2 })
    guard.guard(event(), win)
    await vi.waitFor(() => expect(quit).toHaveBeenCalled())
    expect(queue.unfinishedCount()).toBe(0)
    expect(queue.status().running).toBe(false)
  })
})

describe('unfinished generations from the previous run', () => {
  const items: QueueItem[] = [{ id: 'a', state: 'pending', request: REQ }]

  it('resumes them on confirm and discards them on Esc', async () => {
    const restore = vi.fn()
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    await offerUnfinishedGenerations({ restore }, items, win)
    expect(restore).toHaveBeenLastCalledWith(items, true)
    expect(showMessageBox.mock.calls[0][1]).toMatchObject({ cancelId: 1 })

    showMessageBox.mockResolvedValueOnce({ response: 1 })
    await offerUnfinishedGenerations({ restore }, items, win)
    expect(restore).toHaveBeenLastCalledWith(items, false)
  })
})

describe('GenerationQueue journal', () => {
  function recordingJournal(): QueueJournal & { rows: Set<string> } {
    const rows = new Set<string>()
    return {
      rows,
      add: (items, commit) => {
        items.forEach((item) => rows.add(item.id))
        commit?.()
      },
      update: () => {},
      remove: (ids) => ids.forEach((id) => rows.delete(id))
    }
  }

  it('journals queued items and forgets them once finished', async () => {
    const journal = recordingJournal()
    const queue = new GenerationQueue(async () => '/a.png')
    queue.setJournal(journal)
    queue.setDelayMs(0)
    queue.enqueue(REQ, 2)
    expect(journal.rows.size).toBe(2)
    await vi.waitFor(() => expect(queue.status().running).toBe(false))
    expect(journal.rows.size).toBe(0)
  })

  it('keeps generating when the journal cannot be written', async () => {
    const queue = new GenerationQueue(async () => '/a.png')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    queue.setJournal({
      add: () => {
        throw new Error('disk full')
      },
      update: () => {},
      remove: () => {
        throw new Error('disk full')
      }
    })
    queue.enqueue(REQ, 1)
    await vi.waitFor(() => expect(queue.status().items[0].state).toBe('done'))
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('does not restore an item twice or re-journal restored items', () => {
    const journal = recordingJournal()
    const add = vi.spyOn(journal, 'add')
    const queue = new GenerationQueue(hanging)
    queue.setJournal(journal)
    const restored: QueueItem[] = [{ id: 'x', state: 'generating', request: REQ }]
    queue.restore(restored, true)
    queue.restore(restored, true)
    expect(add).not.toHaveBeenCalled()
    expect(queue.status().items).toHaveLength(1)
    expect(queue.status().items[0].state).toBe('generating')
  })
})
