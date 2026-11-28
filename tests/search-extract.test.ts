import { describe, expect, it } from 'vitest'
import {
  canonicalArtist,
  extractArtists,
  normalizeSearchModel,
  normalizeSearchText,
  searchDocumentFromMetadata,
  searchDocumentFromPayload
} from '../src/shared/search-extract'

describe('search text normalization', () => {
  it('drops weights and emphasis and treats underscores as spaces', () => {
    expect(normalizeSearchText('1.2::Blue_Eyes::, {long hair}, [smile], -0.5::bad::')).toBe(
      'blue eyes , long hair , smile , bad'
    )
  })

  it('canonicalizes artist names with underscores', () => {
    expect(canonicalArtist(' Mika Pikazo ')).toBe('mika_pikazo')
  })

  it('extracts artist tags from weighted, braced and repeated prompts', () => {
    expect(
      extractArtists([
        '1girl, artist:wlop, 1.3::artist:Mika Pikazo::, {artist:ask_(askzy)}',
        'artist:WLOP, solo'
      ])
    ).toEqual(['wlop', 'mika_pikazo', 'ask_askzy'])
  })
})

describe('search model normalization', () => {
  it('keeps V5 Full and V5 Full Medium apart and drops the inpainting suffix', () => {
    expect(normalizeSearchModel('nai-diffusion-5-full')).toBe('nai-diffusion-5-full')
    expect(normalizeSearchModel('nai-diffusion-5-full-medium')).toBe('nai-diffusion-5-full-medium')
    expect(normalizeSearchModel('nai-diffusion-5-full-medium-inpainting')).toBe(
      'nai-diffusion-5-full-medium'
    )
    expect(normalizeSearchModel('nai-diffusion-4-5-curated-inpainting')).toBe(
      'nai-diffusion-4-5-curated'
    )
  })

  it('returns null for unknown or empty sources', () => {
    expect(normalizeSearchModel('')).toBeNull()
    expect(normalizeSearchModel(null)).toBeNull()
    expect(normalizeSearchModel('Some Other Model')).toBeNull()
  })
})

describe('search documents', () => {
  it('reads prompt, characters, names and model from a generation payload', () => {
    const payload = JSON.stringify({
      action: 'generate',
      input: '1girl, artist:wlop, Blue_Eyes',
      model: 'nai-diffusion-4-5-full-inpainting',
      parameters: {
        seed: 123,
        v4_prompt: {
          caption: {
            base_caption: 'ignored when input exists',
            char_captions: [{ char_caption: 'girl, red hair, artist:foo' }]
          }
        },
        characterPrompts: [{ prompt: 'girl, red hair, artist:foo' }]
      },
      nais3: { characterNames: ['아리스'] }
    })
    const doc = searchDocumentFromPayload(payload, { kind: 'inpaint', seed: null })
    expect(doc).toEqual({
      kind: 'inpaint',
      modelId: 'nai-diffusion-4-5-full',
      seed: 123,
      promptText: '1girl, artist:wlop, blue eyes',
      artistText: 'wlop foo',
      characterText: '아리스, girl, red hair, artist:foo',
      nameText: ''
    })
  })

  it('prefers the row seed and survives broken or empty payloads', () => {
    expect(searchDocumentFromPayload('{not json', { kind: 'upscale', seed: 7 })).toEqual({
      kind: 'upscale',
      modelId: null,
      seed: 7,
      promptText: '',
      artistText: '',
      characterText: '',
      nameText: ''
    })
    const doc = searchDocumentFromPayload(JSON.stringify({ parameters: { seed: 5 } }), {
      kind: 't2i',
      seed: 9,
      name: 'Cover_Final.png'
    })
    expect(doc.seed).toBe(9)
    expect(doc.nameText).toBe('cover final.png')
  })

  it('falls back to the base caption when there is no input', () => {
    const payload = JSON.stringify({
      parameters: { v4_prompt: { caption: { base_caption: 'scenery, artist:bar' } } }
    })
    const doc = searchDocumentFromPayload(payload, { kind: 'scene', seed: null })
    expect(doc.promptText).toBe('scenery, artist:bar')
    expect(doc.artistText).toBe('bar')
  })

  it('builds a document from PNG metadata, or the name alone without it', () => {
    const doc = searchDocumentFromMetadata(
      {
        prompt: 'artist:wlop, night sky',
        seed: 42,
        model: 'nai-diffusion-5-curated',
        characterPrompts: [{ prompt: 'boy, black hair' }]
      } as never,
      { name: 'sky.png' }
    )
    expect(doc).toMatchObject({
      kind: null,
      modelId: 'nai-diffusion-5-curated',
      seed: 42,
      promptText: 'artist:wlop, night sky',
      artistText: 'wlop',
      characterText: 'boy, black hair',
      nameText: 'sky.png'
    })
    expect(searchDocumentFromMetadata(null, { name: 'a.png' })).toMatchObject({
      modelId: null,
      seed: null,
      promptText: '',
      nameText: 'a.png'
    })
  })
})
