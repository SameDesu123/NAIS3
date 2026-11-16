import { Worker } from 'worker_threads'
import type { ImageMetadata } from '../../shared/types'
import workerPath from './metadata.worker?modulePath'
import type { MetadataInput, MetadataRequest, MetadataResponse } from './metadata-messages'

const IDLE_TIMEOUT_MS = 60_000

interface PendingRequest {
  resolve: (meta: ImageMetadata | null) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
let nextRequestId = 1
let idleTimer: NodeJS.Timeout | null = null
const pending = new Map<number, PendingRequest>()

function clearIdleTimer(): void {
  if (!idleTimer) return
  clearTimeout(idleTimer)
  idleTimer = null
}

function scheduleIdleTermination(): void {
  clearIdleTimer()
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (pending.size > 0 || !worker) return
    const idleWorker = worker
    worker = null
    void idleWorker.terminate()
  }, IDLE_TIMEOUT_MS)
  idleTimer.unref()
}

function getWorker(): Worker {
  if (worker) return worker
  const created = new Worker(workerPath)
  worker = created

  created.on('message', (response: MetadataResponse) => {
    if (worker !== created) return
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    if ('error' in response) request.reject(new Error(response.error))
    else request.resolve(response.meta)
    if (pending.size === 0) scheduleIdleTermination()
  })

  const fail = (error: Error): void => {
    if (worker !== created) return
    worker = null
    clearIdleTimer()
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  created.once('error', fail)
  created.once('exit', (code) => {
    fail(new Error(`Image metadata worker exited with code ${code}`))
  })
  created.unref()
  return created
}

export function readImageMetadata(input: MetadataInput): Promise<ImageMetadata | null> {
  clearIdleTimer()
  return new Promise((resolve, reject) => {
    const id = nextRequestId++
    pending.set(id, { resolve, reject })
    const request: MetadataRequest = { id, ...input }
    try {
      // Clone the bytes: transferring would detach buffers still used by memoryImages.
      getWorker().postMessage(request)
    } catch (error) {
      pending.delete(id)
      if (worker && pending.size === 0) scheduleIdleTermination()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
