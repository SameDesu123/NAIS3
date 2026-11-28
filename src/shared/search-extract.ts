import { vibeModelFor } from './metadata-vibes'
import { generationModelFor } from './nai-models'
import type { ImageMetadata } from './types'

/**
 * 히스토리·라이브러리 검색 문서. 메인(SQLite 검색 메타 테이블)과 브라우저 작업 공간(인메모리 매처)이
 * 같은 규칙으로 만든다. 텍스트 필드는 모두 normalizeSearchText를 거친 값이다.
 */
export interface SearchDocument {
  kind: string | null
  /** 정규화 모델 id (인페인트 접미사 제거, V5 Full과 V5 Full Medium은 구분). 모르면 null */
  modelId: string | null
  seed: number | null
  promptText: string
  /** 작가 태그의 정규 이름(공백은 _)을 공백으로 이은 것 — 집계 때 공백으로 나눈다 */
  artistText: string
  characterText: string
  /** 라이브러리 파일 이름 (히스토리는 '') */
  nameText: string
}

/**
 * 검색용 정규화: 소문자, 가중치·강조 구문(`1.2::tag::`, `{}`, `[]`, `()`) 제거, 언더스코어를 공백으로.
 * Danbooru식 `blue_eyes`와 `blue eyes`가 같은 문서·같은 검색어가 된다.
 */
export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/-?\d+(?:\.\d+)?::/g, ' ')
    .replace(/::/g, ' ')
    .replace(/[{}[\]()]/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 작가 태그의 정규 이름 — 정규화 후 공백을 _로 (artist_text의 공백 구분을 지키기 위해) */
export function canonicalArtist(name: string): string {
  return normalizeSearchText(name).replace(/ /g, '_')
}

const ARTIST_RE = /artist:\s*([^,\n{}[\]|:]+)/gi

/** 프롬프트들에서 `artist:이름` 태그를 뽑는다 (`1.2::artist:wlop::`, `{artist:foo}` 포함). 중복 제거 */
export function extractArtists(texts: readonly string[]): string[] {
  const out = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(ARTIST_RE)) {
      const name = canonicalArtist(match[1])
      if (name) out.add(name)
    }
  }
  return [...out]
}

/**
 * 검색 필터용 모델 id. NAI API id는 인페인트 접미사만 떼고(Medium은 별도 모델로 유지),
 * PNG Source 문자열은 알려진 것만 id로 바꾼다. 모르면 null.
 */
export function normalizeSearchModel(model: string | null | undefined): string | null {
  const trimmed = model?.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('nai-diffusion-')) return generationModelFor(trimmed)
  return vibeModelFor(trimmed) ?? null
}

function strings(values: unknown[]): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function finiteInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function buildDocument(input: {
  kind: string | null
  model: string | null | undefined
  seed: number | null
  prompt: string
  characterPrompts: string[]
  characterNames: string[]
  name?: string
}): SearchDocument {
  return {
    kind: input.kind,
    modelId: normalizeSearchModel(input.model),
    seed: input.seed,
    promptText: normalizeSearchText(input.prompt),
    artistText: extractArtists([input.prompt, ...input.characterPrompts]).join(' '),
    characterText: normalizeSearchText([...input.characterNames, ...input.characterPrompts].join(', ')),
    nameText: normalizeSearchText(input.name ?? '')
  }
}

/**
 * 우리 payload_json({action, input, model, parameters, nais3}) → 검색 문서.
 * 디렉터·업스케일 요청처럼 프롬프트·모델이 없는 payload도 kind·시드만으로 문서가 된다.
 */
export function searchDocumentFromPayload(
  payloadJson: string | null | undefined,
  base: { kind: string | null; seed: number | null; name?: string }
): SearchDocument {
  let payload: Record<string, unknown> = {}
  try {
    payload = record(payloadJson ? JSON.parse(payloadJson) : null)
  } catch {
    payload = {}
  }
  const params = record(payload.parameters)
  const caption = record(record(params.v4_prompt).caption)
  const prompt =
    typeof payload.input === 'string'
      ? payload.input
      : typeof caption.base_caption === 'string'
        ? caption.base_caption
        : ''
  const characterPrompts = strings([
    ...list(caption.char_captions).map((c) => record(c).char_caption),
    ...list(params.characterPrompts).map((c) => record(c).prompt)
  ])
  return buildDocument({
    kind: base.kind,
    model: typeof payload.model === 'string' ? payload.model : null,
    seed: base.seed ?? finiteInt(params.seed),
    prompt,
    // v4_prompt와 레거시 characterPrompts는 같은 캐릭터를 두 번 담는다
    characterPrompts: [...new Set(characterPrompts)],
    characterNames: strings(list(record(payload.nais3).characterNames)),
    name: base.name
  })
}

/** PNG 메타데이터(외부 파일·라이브러리 가져오기) → 검색 문서. 메타가 없으면 이름만 */
export function searchDocumentFromMetadata(
  meta: ImageMetadata | null,
  base: { kind?: string | null; name?: string }
): SearchDocument {
  return buildDocument({
    kind: base.kind ?? null,
    model: meta?.modelId ?? meta?.model ?? null,
    seed: meta?.seed ?? null,
    prompt: meta?.prompt ?? '',
    characterPrompts: strings((meta?.characterPrompts ?? []).map((c) => c.prompt)),
    characterNames: [],
    name: base.name
  })
}
