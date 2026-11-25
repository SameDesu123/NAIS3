import { expect, it } from 'vitest'
import { promptTags, stripDisabledTags, togglePromptTag } from '../src/shared/prompt-tags'
import { disabledWeightGroups } from '../src/shared/prompt-tags'
import { removeComments } from '../src/shared/nai-presets'

it('toggles one occurrence, preserves text and restores it exactly', () => {
  const text = 'blue eyes, blue eyes, 한글 태그'
  const tag = promptTags(text)[1]
  const off = togglePromptTag(text, tag.start, tag.end)
  expect(stripDisabledTags(off)).toBe('blue eyes, , 한글 태그')
  const disabled = promptTags(off)[1]
  expect(togglePromptTag(off, disabled.start, disabled.end)).toBe(text)
})
it('keeps weighting delimiters and excludes comments and fragment paths', () => {
  const text = '1.5::{blue eyes}::, <folder/name>, # comment'
  expect(promptTags(text).map((r) => text.slice(r.start, r.end))).toEqual(['blue eyes'])
  const tag = promptTags(text)[0]
  expect(removeComments(togglePromptTag(text, tag.start, tag.end))).toBe(
    ', <folder/name>, # comment'
  )
})
it('handles unicode and whitespace without losing enabled text', () => {
  const text = '  한글 😀, red hair'
  const tag = promptTags(text)[0]
  const off = togglePromptTag(text, tag.start, tag.end)
  expect(stripDisabledTags(off)).toBe('  , red hair')
  const r = promptTags(off)[0]
  expect(togglePromptTag(off, r.start, r.end)).toBe(text)
})

it('only commas split tags, including newlines and colons inside text', () => {
  const text = 'blue eyes\nred hair: detail, smile'
  expect(promptTags(text).map((t) => text.slice(t.start, t.end))).toEqual([
    'blue eyes\nred hair: detail',
    'smile'
  ])
})
it('disables a weight only when every child is off and restores it with one enabled child', () => {
  let text = '1.5::blue eyes, red hair::, smile'
  let tags = promptTags(text)
  text = togglePromptTag(text, tags[0].start, tags[0].end)
  expect(disabledWeightGroups(text)).toHaveLength(0)
  expect(stripDisabledTags(text)).toContain('1.5::')
  tags = promptTags(text)
  text = togglePromptTag(text, tags[1].start, tags[1].end)
  expect(disabledWeightGroups(text)).toHaveLength(1)
  expect(stripDisabledTags(text)).toBe(', smile')
  tags = promptTags(text)
  text = togglePromptTag(text, tags[0].start, tags[0].end)
  expect(disabledWeightGroups(text)).toHaveLength(0)
  expect(stripDisabledTags(text)).toBe('1.5::blue eyes, ::, smile')
})
it('removes nested empty weight wrappers with all children off', () => {
  let text = '1.5::{blue eyes, red hair}::'
  for (let i = 0; i < 2; i++) {
    const t = promptTags(text)[i]
    text = togglePromptTag(text, t.start, t.end)
  }
  expect(stripDisabledTags(text)).toBe('')
})
