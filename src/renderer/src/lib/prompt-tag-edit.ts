import { togglePromptTag } from '@shared/prompt-tags'

export function applyPromptTagToggle(
  ta: HTMLTextAreaElement,
  value: string,
  start: number,
  end: number,
  onValueChange: (value: string) => void
): void {
  const next = togglePromptTag(value, start, end)
  const replacement = next.slice(start, next.length - (value.length - end))
  const oldStart = ta.selectionStart,
    oldEnd = ta.selectionEnd,
    direction = ta.selectionDirection
  const scrollTop = ta.scrollTop,
    scrollLeft = ta.scrollLeft
  const enabling = value.slice(start, end).includes('\u0336')
  const map = (position: number): number => {
    if (position <= start) return position
    if (position >= end) return position + next.length - value.length
    const prefix = value.slice(start, position)
    return (
      start +
      (enabling
        ? prefix.replaceAll('\u0336', '').length
        : togglePromptTag(prefix, 0, prefix.length).length)
    )
  }
  ta.focus()
  ta.setSelectionRange(start, end)
  // Chromium inserts this into the textarea's native undo history (including Ctrl+Z).
  const inserted =
    typeof document.execCommand === 'function' &&
    document.execCommand('insertText', false, replacement)
  if (!inserted) ta.setRangeText(replacement, start, end, 'end')
  onValueChange(ta.value)
  requestAnimationFrame(() => {
    if (!ta.isConnected) return
    ta.setSelectionRange(map(oldStart), map(oldEnd), direction)
    ta.scrollTop = scrollTop
    ta.scrollLeft = scrollLeft
  })
}
