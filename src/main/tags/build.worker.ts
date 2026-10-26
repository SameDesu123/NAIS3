import { parentPort, workerData } from 'worker_threads'
import { buildTagsDb, type TagsBuildWorkerData, type TagsBuildWorkerMessage } from './store'

const port = parentPort
if (!port) throw new Error('Tags DB worker requires a parent port')
const send = (message: TagsBuildWorkerMessage): void => port.postMessage(message)

const { source, destination } = workerData as TagsBuildWorkerData
try {
  buildTagsDb(source, destination)
  send({ type: 'done' })
} catch (error) {
  send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
}
