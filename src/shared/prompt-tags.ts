const STRIKE = '\u0336'
interface Group {
  start: number
  openEnd: number
  closeStart: number
  end: number
}
function weightGroups(text: string): Group[] {
  const groups: Group[] = [],
    stack: { start: number; openEnd: number; close: string }[] = []
  for (let i = 0; i < text.length;) {
    const open = /^-?\d+(?:\.\d+)?::/.exec(text.slice(i))
    if (open) {
      stack.push({ start: i, openEnd: i + open[0].length, close: '::' })
      i += open[0].length
      continue
    }
    const top = stack[stack.length - 1]
    if (top && text.startsWith(top.close, i)) {
      stack.pop()
      groups.push({
        start: top.start,
        openEnd: top.openEnd,
        closeStart: i,
        end: i + top.close.length
      })
      i += top.close.length
      continue
    }
    if (text[i] === '{' || text[i] === '[')
      stack.push({ start: i, openEnd: i + 1, close: text[i] === '{' ? '}' : ']' })
    i++
  }
  return groups
}
export function promptTags(text: string): { start: number; end: number; disabled: boolean }[] {
  const syntax = new Set<number>()
  for (const group of weightGroups(text)) {
    for (let i = group.start; i < group.openEnd; i++) syntax.add(i)
    for (let i = group.closeStart; i < group.end; i++) syntax.add(i)
  }
  const tags: { start: number; end: number; disabled: boolean }[] = []
  // Only commas divide tags; whitespace and line breaks remain part of a tag.
  for (const match of text.matchAll(/[^,]+/g)) {
    let start = match.index!,
      end = start + match[0].length
    while (start < end && (syntax.has(start) || /\s/.test(text[start]))) start++
    while (end > start && (syntax.has(end - 1) || /\s/.test(text[end - 1]))) end--
    if (start === end) continue
    const raw = text.slice(start, end)
    if (raw.trimStart().startsWith('#') || /^<[^<>]+>$/.test(raw)) continue
    tags.push({ start, end, disabled: raw.includes(STRIKE) })
  }
  return tags
}
export function togglePromptTag(text: string, start: number, end: number): string {
  const tag = text.slice(start, end)
  const replacement = tag.includes(STRIKE)
    ? tag.replaceAll(STRIKE, '')
    : Array.from(tag)
        .map((char) => char + STRIKE)
        .join('')
  return text.slice(0, start) + replacement + text.slice(end)
}
export function disabledWeightGroups(text: string): Group[] {
  const tags = promptTags(text)
  return weightGroups(text).filter((group) => {
    const inside = tags.filter((tag) => tag.start < group.closeStart && tag.end > group.openEnd)
    return inside.length > 0 && inside.every((tag) => tag.disabled)
  })
}
export function stripDisabledTags(text: string): string {
  const ranges = [
    ...promptTags(text).filter((tag) => tag.disabled),
    ...disabledWeightGroups(text)
  ].sort((a, b) => a.start - b.start)
  let result = '',
    cursor = 0
  for (const range of ranges) {
    if (range.end <= cursor) continue
    result += text.slice(cursor, Math.max(cursor, range.start))
    cursor = range.end
  }
  return result + text.slice(cursor)
}
