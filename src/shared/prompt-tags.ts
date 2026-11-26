const STRIKE = '\u0336'
interface Group {
  start: number
  openEnd: number
  closeStart: number
  end: number
}
export function maskPromptComments(text: string): string {
  return text.replace(/^[ \t]*#[^\r\n]*/gm, (line) => ' '.repeat(line.length))
}
function weightGroups(text: string): Group[] {
  const groups: Group[] = [],
    stack: { start: number; openEnd: number; close: string }[] = []
  const numeric = /-?\d+(?:\.\d+)?::/y
  for (let i = 0; i < text.length;) {
    numeric.lastIndex = i
    const open = numeric.exec(text)
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
export function promptTags(
  text: string,
  groups = weightGroups(maskPromptComments(text))
): { start: number; end: number; disabled: boolean }[] {
  const masked = maskPromptComments(text)
  const syntax = new Set<number>()
  for (const group of groups) {
    for (let i = group.start; i < group.openEnd; i++) syntax.add(i)
    for (let i = group.closeStart; i < group.end; i++) syntax.add(i)
  }
  const tags: { start: number; end: number; disabled: boolean }[] = []
  // Only commas divide tags; whitespace and line breaks remain part of a tag.
  for (const match of masked.matchAll(/[^,]+/g)) {
    let start = match.index!,
      end = start + match[0].length
    while (start < end && (syntax.has(start) || /\s/.test(masked[start]))) start++
    while (end > start && (syntax.has(end - 1) || /\s/.test(masked[end - 1]))) end--
    if (start === end) continue
    const raw = masked.slice(start, end)
    if (/^<[^<>]+>$/.test(raw)) continue
    tags.push({ start, end, disabled: raw.includes(STRIKE) })
  }
  return tags
}
export function togglePromptTag(text: string, start: number, end: number): string {
  const tag = text.slice(start, end)
  const enabling = maskPromptComments(text).slice(start, end).includes(STRIKE)
  const comments = [...text.matchAll(/^[ \t]*#[^\r\n]*/gm)].map((m) => ({
    start: m.index!,
    end: m.index! + m[0].length
  }))
  let replacement = '',
    offset = start
  for (const char of tag) {
    const comment = comments.some((range) => offset >= range.start && offset < range.end)
    replacement += enabling
      ? char === STRIKE && !comment
        ? ''
        : char
      : char + (comment || char === '\n' || char === '\r' ? '' : STRIKE)
    offset += char.length
  }
  return text.slice(0, start) + replacement + text.slice(end)
}
export function disabledWeightGroups(
  text: string,
  tags = promptTags(text),
  groups = weightGroups(maskPromptComments(text))
): Group[] {
  return groups.filter((group) => {
    const inside = tags.filter((tag) => tag.start < group.closeStart && tag.end > group.openEnd)
    return inside.length > 0 && inside.every((tag) => tag.disabled)
  })
}
export function stripDisabledTags(text: string): string {
  const tags = promptTags(text)
  const ranges = [...tags.filter((tag) => tag.disabled), ...disabledWeightGroups(text, tags)].sort(
    (a, b) => a.start - b.start
  )
  if (!ranges.length) return text
  let result = '',
    cursor = 0
  for (const range of ranges) {
    if (range.end <= cursor) continue
    result += text.slice(cursor, Math.max(cursor, range.start))
    cursor = range.end
  }
  result += text.slice(cursor)
  // Only trim commas at actual opening/closing weight boundaries; :: can be either.
  const trims: { start: number; end: number }[] = []
  for (const group of weightGroups(maskPromptComments(result))) {
    const inner = result.slice(group.openEnd, group.closeStart)
    const leading = /^\s*,\s*/.exec(inner)
    const trailing = /,\s*$/.exec(inner)
    if (leading) trims.push({ start: group.openEnd, end: group.openEnd + leading[0].length })
    if (trailing) trims.push({ start: group.openEnd + trailing.index, end: group.closeStart })
  }
  for (const range of trims.sort((a, b) => b.start - a.start))
    result = result.slice(0, range.start) + result.slice(range.end)
  return result
    .replace(/,(\s*,)+/g, ',')
    .replace(/(^\s*,\s*|,\s*$)/g, '')
    .trim()
}

export function analyzePromptTags(text: string): {
  tags: ReturnType<typeof promptTags>
  disabledGroups: Group[]
} {
  const groups = weightGroups(maskPromptComments(text))
  const tags = promptTags(text, groups)
  return { tags, disabledGroups: disabledWeightGroups(text, tags, groups) }
}
