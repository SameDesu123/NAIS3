/**
 * Stored webp thumbnails are served by the nais-image protocol instead of being shipped
 * through IPC as base64, so list responses stay small and Chromium decodes images lazily.
 */
export const THUMBNAIL_SOURCES = ['image', 'library'] as const
export type ThumbnailSource = (typeof THUMBNAIL_SOURCES)[number]

export function isThumbnailSource(value: string | null): value is ThumbnailSource {
  return (THUMBNAIL_SOURCES as readonly string[]).includes(value ?? '')
}

/**
 * The `v` param must change whenever a row id could point at different content. INTEGER PRIMARY
 * KEY ids are reused after the newest row is deleted, and created_at only has second precision,
 * so the version combines the row's created_at with its thumbnail byte length.
 */
export function thumbnailUrl(
  source: ThumbnailSource,
  id: number,
  createdAt: string,
  size: number
): string {
  const version = encodeURIComponent(`${createdAt}~${size}`)
  return `nais-image://local/?thumb=${source}&id=${id}&v=${version}`
}

/**
 * A scene card's cover, served from the cover cache. The main process checks the cover against
 * the scene's current cover image and its file on every request, so the response is not cached;
 * the version only makes the card reload when the cover moves to another image.
 */
export function coverUrl(sceneId: number, imageId: number, createdAt: string): string {
  const version = encodeURIComponent(`${imageId}~${createdAt}`)
  return `nais-image://local/?cover=${sceneId}&v=${version}`
}
