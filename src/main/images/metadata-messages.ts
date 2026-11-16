import type { ImageMetadata } from '../../shared/types'

export interface MetadataInput {
  /** Base64 from an external drop, or bytes from a stored/in-memory image. */
  image?: string | Uint8Array
  payloadJson?: string
}

export interface MetadataRequest extends MetadataInput {
  id: number
}

export type MetadataResponse =
  { id: number; meta: ImageMetadata | null } | { id: number; error: string }
