/** 씬 JSON 가져오기로 들어오는 씬 1개 (없는 필드는 저장할 때 기본값) */
export interface ImportedScene {
  name?: string
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
}

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/**
 * 씬 JSON을 해석한다 — NAIS2 `importPreset`이 받던 형식을 모두 받는다.
 * - NAIS3/NAIS2 내보내기: `{ scenes: [{ name, prompt | scenePrompt, ... }] }`
 * - 구형 scene_preset_export.json: `[{ scene_name, scene_prompt }]`
 * - 상호작용 공유(NAI 에셋봇): `{ scenes: { key: { name, slots: [[{ prompt, enabled }]] } } }`
 *   — 슬롯마다 켜진 항목 하나씩 고른 조합이 각각 씬이 된다
 * - SDImageGenEasy: `{ presets: { SDImageGenEasy: [{ name, frontPrompt, backPrompt }] } }`
 * 형식을 알 수 없으면 null.
 */
export function parseSceneImport(raw: string): ImportedScene[] | null {
  let data: unknown
  try {
    // 메모장 등으로 저장하면 BOM이 붙는다
    data = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }

  if (Array.isArray(data)) {
    return data.filter(isObj).map((item) => ({
      name: str(item.scene_name),
      prompt: str(item.scene_prompt) ?? ''
    }))
  }
  if (!isObj(data)) return null

  if (Array.isArray(data.scenes)) {
    return data.scenes.filter(isObj).map((s) => ({
      name: str(s.name),
      prompt: str(s.prompt) ?? str(s.scenePrompt) ?? '', // NAIS2 파일은 scenePrompt
      negativePrompt: str(s.negativePrompt),
      width: num(s.width),
      height: num(s.height)
    }))
  }

  if (isObj(data.scenes)) {
    const scenes: ImportedScene[] = []
    for (const scene of Object.values(data.scenes)) {
      if (!isObj(scene) || !Array.isArray(scene.slots)) continue
      const prompts = slotCombinations(scene.slots)
      const name = str(scene.name) ?? 'Untitled'
      prompts.forEach((prompt, i) => {
        scenes.push({ name: prompts.length > 1 ? `${name}_${i + 1}` : name, prompt })
      })
    }
    return scenes
  }

  const easy = isObj(data.presets) ? data.presets.SDImageGenEasy : undefined
  if (Array.isArray(easy)) {
    return easy.filter(isObj).map((item) => ({
      name: str(item.name),
      prompt: [str(item.frontPrompt), str(item.backPrompt)].filter(Boolean).join(', ')
    }))
  }

  return null
}

/** 슬롯마다 켜진 항목 하나씩 골라 앞 슬롯부터 이어 붙인 모든 조합 (켜진 항목이 없는 슬롯은 건너뜀) */
function slotCombinations(slots: unknown[]): string[] {
  let results = ['']
  for (const slot of slots) {
    const items = Array.isArray(slot)
      ? slot.filter((item): item is Obj => isObj(item) && item.enabled !== false)
      : []
    if (items.length === 0) continue
    results = results.flatMap((prev) =>
      items.map((item) => {
        const prompt = str(item.prompt) ?? ''
        return prev ? `${prev}, ${prompt}` : prompt
      })
    )
  }
  return results
}
