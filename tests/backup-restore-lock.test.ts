import { describe, expect, it, vi } from 'vitest'
import { RestoreLock } from '../src/shared/backup-restore'

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function lock(): { lock: RestoreLock; notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn()
  return {
    lock: new RestoreLock({ notify, refusal: () => new Error('restore in progress') }),
    notify
  }
}

describe('backup restore lock', () => {
  it('refuses writes that arrive while the restore runs, and lets reads through', async () => {
    const { lock: restoreLock, notify } = lock()
    const unzip = deferred()
    const write = vi.fn()
    const restore = restoreLock.restore(async () => {
      await unzip.promise
      return 'restored'
    })

    expect(restoreLock.active).toBe(true)
    expect(notify).toHaveBeenLastCalledWith(true)
    await expect(restoreLock.request('chars:create', write)).rejects.toThrow('restore in progress')
    await expect(restoreLock.request('settings:set', write)).rejects.toThrow()
    expect(write).not.toHaveBeenCalled()
    await expect(restoreLock.request('chars:list', () => 'rows')).resolves.toBe('rows')
    await expect(restoreLock.request('backup:restoreStatus', () => 'status')).resolves.toBe(
      'status'
    )

    unzip.resolve()
    await expect(restore).resolves.toBe('restored')
    expect(restoreLock.active).toBe(false)
    expect(notify.mock.calls).toEqual([[true], [false]])
    await expect(restoreLock.request('chars:create', () => 'written')).resolves.toBe('written')
  })

  it('waits for a write already running, so it is never interleaved with the restore', async () => {
    const { lock: restoreLock } = lock()
    const order: string[] = []
    const slowWrite = deferred()
    const write = restoreLock.request('library:importImages', async () => {
      order.push('write started')
      await slowWrite.promise
      order.push('write finished')
    })
    const restore = restoreLock.restore(() => {
      order.push('restore')
    })

    await Promise.resolve()
    expect(order).toEqual(['write started'])
    slowWrite.resolve()
    await Promise.all([write, restore])
    expect(order).toEqual(['write started', 'write finished', 'restore'])
  })

  it('refuses an overlapping restore and always releases the lock', async () => {
    const { lock: restoreLock, notify } = lock()
    const unzip = deferred()
    const first = restoreLock.restore(async () => {
      await unzip.promise
      throw new Error('corrupt archive')
    })
    const second = vi.fn()
    await expect(restoreLock.restore(second)).rejects.toThrow('restore in progress')
    expect(second).not.toHaveBeenCalled()

    unzip.resolve()
    await expect(first).rejects.toThrow('corrupt archive')
    expect(restoreLock.active).toBe(false)
    expect(notify.mock.calls).toEqual([[true], [false]])
  })

  it('refuses channels it does not know during a restore', async () => {
    const { lock: restoreLock } = lock()
    const unzip = deferred()
    const restore = restoreLock.restore(() => unzip.promise)
    await expect(restoreLock.request('someFuture:write', () => 'x')).rejects.toThrow()
    unzip.resolve()
    await restore
  })
})
