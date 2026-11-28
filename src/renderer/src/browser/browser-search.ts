import { searchDocumentFromPayload, type SearchDocument } from '@shared/search-extract'
import { kindGroupOf, matchesSearchDocument, type CompiledSearch } from '@shared/search-query'
import type { SearchFacetCount, SearchFacets } from '@shared/types'
import type { BrowserImage, BrowserLibraryImage, BrowserState } from './browser-db'

/**
 * 브라우저 작업 공간의 검색 — 데스크톱 색인과 같은 문서·같은 매처를 메모리에서 돌린다.
 * 기록이 많지 않은 개발용 작업 공간이라 색인 없이 매번 만든다.
 */

export function browserImageDocument(image: BrowserImage): SearchDocument {
  return searchDocumentFromPayload(image.payloadJson, { kind: image.kind, seed: image.seed })
}

/** 라이브러리 이미지 문서 — 히스토리에서 가져온 것이면 그 기록의 payload, 아니면 이름만 */
export function browserLibraryDocument(
  state: BrowserState,
  image: BrowserLibraryImage
): SearchDocument {
  const history = state.images.find((candidate) => candidate.filePath === image.filePath)
  return searchDocumentFromPayload(history?.payloadJson ?? null, {
    kind: history?.kind ?? null,
    seed: history?.seed ?? null,
    name: image.name
  })
}

export function filterBrowserImages(images: BrowserImage[], search: CompiledSearch): BrowserImage[] {
  return images.filter((image) =>
    matchesSearchDocument(browserImageDocument(image), search, {
      createdAt: image.createdAt,
      favorite: image.favorite
    })
  )
}

export function filterBrowserLibrary(
  state: BrowserState,
  images: BrowserLibraryImage[],
  search: CompiledSearch
): BrowserLibraryImage[] {
  const stackNames = new Map(state.libraryStacks.map((stack) => [stack.id, stack.name]))
  return images.filter((image) =>
    matchesSearchDocument(browserLibraryDocument(state, image), search, {
      // 브라우저 라이브러리 이미지에는 시각이 없다 — 날짜 필터에는 걸리지 않는다
      createdAt: '',
      stackName: image.stackId != null ? (stackNames.get(image.stackId) ?? null) : null
    })
  )
}

function counted(counts: Map<string, number>): SearchFacetCount[] {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

export function browserSearchFacets(state: BrowserState, scope: 'history' | 'library'): SearchFacets {
  const docs =
    scope === 'history'
      ? state.images.map(browserImageDocument)
      : state.libraryImages.map((image) => browserLibraryDocument(state, image))
  const models = new Map<string, number>()
  const kinds = new Map<string, number>()
  const artists = new Map<string, number>()
  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  for (const doc of docs) {
    if (doc.modelId) bump(models, doc.modelId)
    const group = kindGroupOf(doc.kind)
    if (group) bump(kinds, group)
    for (const name of new Set(doc.artistText.split(' '))) if (name) bump(artists, name)
  }
  return { models: counted(models), kinds: counted(kinds), topArtists: counted(artists).slice(0, 30) }
}
