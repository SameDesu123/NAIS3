import { app } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 단부루 태그 자동완성 데이터 (resources/tags.json, 게시물 10건 이상).
 * NAIS2는 이걸 렌더러 번들에 넣었지만, NAIS3는 메인에서 lazy 로드 + IPC 검색으로 서빙
 * — 렌더러 메모리/번들에 대용량 데이터를 싣지 않는다.
 */

export interface TagEntry {
  tag: string
  count: number
  type: string
}

let tags: TagEntry[] | null = null

function load(): TagEntry[] {
  if (tags) return tags
  const raw = JSON.parse(
    readFileSync(join(app.getAppPath(), 'resources', 'tags.json'), 'utf-8')
  ) as { value: string; count: number; type: string }[]
  // count 내림차순 정렬해두면 검색 결과가 자연히 인기순
  tags = raw
    .map((t) => ({ tag: t.value, count: t.count, type: t.type }))
    .sort((a, b) => b.count - a.count)
  return tags
}

export function searchTags(query: string, limit = 8): TagEntry[] {
  const q = query.trim().toLowerCase().replace(/_/g, ' ')
  if (q.length < 2) return []
  const all = load()

  const prefix: TagEntry[] = []
  const substring: TagEntry[] = []
  for (const t of all) {
    if (t.tag.startsWith(q)) {
      prefix.push(t)
      if (prefix.length >= limit) break
    } else if (substring.length < limit && t.tag.includes(q)) {
      substring.push(t)
    }
  }
  return [...prefix, ...substring].slice(0, limit)
}
