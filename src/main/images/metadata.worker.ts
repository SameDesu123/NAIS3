import { parentPort } from 'worker_threads'
import { extractImageMetadata } from './metadata-core'
import type { MetadataRequest, MetadataResponse } from './metadata-messages'

const port = parentPort
if (!port) throw new Error('Image metadata worker requires a parent port')

port.on('message', async (request: MetadataRequest) => {
  let response: MetadataResponse
  try {
    response = { id: request.id, meta: await extractImageMetadata(request) }
  } catch (error) {
    response = {
      id: request.id,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  port.postMessage(response)
})
