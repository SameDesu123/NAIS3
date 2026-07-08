import { getDb } from '../db'
import type { PromptPreset } from '../../shared/types'

/** 프롬프트 프리셋 CRUD — 기본 프롬프트+네거티브를 이름 붙여 저장 */

export function listPromptPresets(): PromptPreset[] {
  return getDb()
    .prepare(
      'SELECT id, name, prompt, negative_prompt AS negativePrompt FROM prompt_presets ORDER BY sort_order, id'
    )
    .all() as PromptPreset[]
}

export function createPromptPreset(name: string, prompt: string, negativePrompt: string): number {
  const db = getDb()
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM prompt_presets').get() as {
    m: number
  }
  const info = db
    .prepare(
      'INSERT INTO prompt_presets (name, prompt, negative_prompt, sort_order) VALUES (?, ?, ?, ?)'
    )
    .run(name, prompt, negativePrompt, max.m + 1)
  return Number(info.lastInsertRowid)
}

export function updatePromptPreset(
  id: number,
  patch: Partial<Pick<PromptPreset, 'name' | 'prompt' | 'negativePrompt'>>
): void {
  const cols: string[] = []
  const vals: unknown[] = []
  if (patch.name !== undefined) (cols.push('name = ?'), vals.push(patch.name))
  if (patch.prompt !== undefined) (cols.push('prompt = ?'), vals.push(patch.prompt))
  if (patch.negativePrompt !== undefined)
    (cols.push('negative_prompt = ?'), vals.push(patch.negativePrompt))
  if (!cols.length) return
  vals.push(id)
  getDb()
    .prepare(`UPDATE prompt_presets SET ${cols.join(', ')} WHERE id = ?`)
    .run(...vals)
}

export function deletePromptPreset(id: number): void {
  getDb().prepare('DELETE FROM prompt_presets WHERE id = ?').run(id)
}

export function reorderPromptPresets(ids: number[]): void {
  const db = getDb()
  const stmt = db.prepare('UPDATE prompt_presets SET sort_order = ? WHERE id = ?')
  db.transaction(() => {
    ids.forEach((id, i) => stmt.run(i, id))
  })()
}
