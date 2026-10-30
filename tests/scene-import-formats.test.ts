import { describe, expect, it } from 'vitest'
import { parseSceneImport } from '../src/main/scenes/import-formats'

const json = (v: unknown): string => JSON.stringify(v)

describe('씬 JSON 가져오기 형식', () => {
  it('NAIS3 내보내기를 그대로 읽는다', () => {
    expect(
      parseSceneImport(
        json({
          version: 1,
          scenes: [{ name: 'A', prompt: 'p', negativePrompt: 'n', width: 1024, height: 1024 }]
        })
      )
    ).toEqual([{ name: 'A', prompt: 'p', negativePrompt: 'n', width: 1024, height: 1024 }])
  })

  it('NAIS2 내보내기의 scenePrompt를 읽는다', () => {
    const scenes = parseSceneImport(
      json({ id: '1', name: 'P', scenes: [{ id: 'x', name: 'S', scenePrompt: 'sp', images: [] }] })
    )
    expect(scenes).toEqual([
      { name: 'S', prompt: 'sp', negativePrompt: undefined, width: undefined, height: undefined }
    ])
  })

  it('구형 scene_preset_export.json (최상위 배열)', () => {
    expect(
      parseSceneImport(json([{ scene_name: 'S1', scene_prompt: 'a' }, { scene_prompt: 'b' }]))
    ).toEqual([
      { name: 'S1', prompt: 'a' },
      { name: undefined, prompt: 'b' }
    ])
  })

  it('상호작용 공유용 슬롯을 켜진 항목의 조합으로 펼친다', () => {
    const scenes = parseSceneImport(
      json({
        name: 'share',
        scenes: {
          s1: {
            name: 'Hug',
            slots: [
              [{ prompt: 'hug' }, { prompt: 'kiss', enabled: false }],
              [{ prompt: 'day' }, { prompt: 'night' }],
              [{ prompt: 'off', enabled: false }]
            ]
          },
          s2: { name: 'Solo', slots: [[{ prompt: 'solo' }]] },
          broken: { name: 'NoSlots' }
        }
      })
    )
    expect(scenes).toEqual([
      { name: 'Hug_1', prompt: 'hug, day' },
      { name: 'Hug_2', prompt: 'hug, night' },
      { name: 'Solo', prompt: 'solo' }
    ])
  })

  it('SDImageGenEasy 프리셋은 앞·뒤 프롬프트를 잇는다', () => {
    expect(
      parseSceneImport(
        json({
          presets: {
            SDImageGenEasy: [
              { name: 'E', frontPrompt: 'front', backPrompt: 'back' },
              { name: 'F', frontPrompt: 'only' }
            ]
          }
        })
      )
    ).toEqual([
      { name: 'E', prompt: 'front, back' },
      { name: 'F', prompt: 'only' }
    ])
  })

  it('BOM이 붙은 파일도 읽는다', () => {
    expect(parseSceneImport('﻿' + json({ scenes: [{ name: 'A', prompt: 'p' }] }))).toHaveLength(1)
  })

  it('알 수 없는 형식·깨진 JSON은 null', () => {
    expect(parseSceneImport('{not json')).toBeNull()
    expect(parseSceneImport(json({ hello: 'world' }))).toBeNull()
    expect(parseSceneImport(json('text'))).toBeNull()
    expect(parseSceneImport(json({ 'nais2-scenes': { state: { presets: [] } } }))).toBeNull()
  })
})
