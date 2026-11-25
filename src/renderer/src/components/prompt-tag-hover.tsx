import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { disabledWeightGroups, promptTags, togglePromptTag } from '@shared/prompt-tags'
import { useT } from '../lib/i18n'

export function PromptTagHover({
  value,
  onValueChange,
  textarea,
  typography
}: {
  value: string
  onValueChange: (value: string) => void
  textarea: RefObject<HTMLTextAreaElement | null>
  typography: string
}): React.JSX.Element {
  const t = useT()
  const mirror = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{
    start: number
    end: number
    disabled: boolean
    x: number
    y: number
  } | null>(null)
  const [menu, setMenu] = useState<typeof hover>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const dismiss = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null)
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenu(null)
        textarea.current?.focus()
      }
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', key)
    }
  }, [menu, textarea])
  const display = (text: string): string => text.replaceAll('\u0336', '\u200b')
  const tags = promptTags(value)
  const disabledGroups = disabledWeightGroups(value)
  const syntaxDisplay = (start: number, end: number): React.ReactNode => {
    const points = new Set([start, end])
    for (const group of disabledGroups) {
      if (group.start > start && group.start < end) points.add(group.start)
      if (group.end > start && group.end < end) points.add(group.end)
    }
    const sorted = [...points].sort((a, b) => a - b)
    return sorted.slice(0, -1).map((point, i) => (
      <span
        key={point}
        style={
          disabledGroups.some((g) => point >= g.start && point < g.end)
            ? {
                color: 'var(--prompt-tag-disabled-ink)',
                background: 'var(--prompt-tag-disabled-bg)',
                boxDecorationBreak: 'clone'
              }
            : undefined
        }
      >
        {display(value.slice(point, sorted[i + 1]))}
      </span>
    ))
  }
  useEffect(() => {
    const ta = textarea.current
    if (!ta) return
    const sync = (): void => {
      if (mirror.current) {
        mirror.current.scrollTop = ta.scrollTop
        mirror.current.scrollLeft = ta.scrollLeft
      }
      setHover(null)
      setMenu(null)
    }
    const leave = (): void => setHover(null)
    const locate = (event: MouseEvent): typeof hover => {
      const spans = mirror.current?.querySelectorAll<HTMLElement>('[data-tag-start]') ?? []
      for (const span of spans) {
        const rect = Array.from(span.getClientRects()).find(
          (r) =>
            event.clientX >= r.left &&
            event.clientX <= r.right &&
            event.clientY >= r.top &&
            event.clientY <= r.bottom
        )
        if (rect) {
          const start = Number(span.dataset.tagStart),
            end = Number(span.dataset.tagEnd)
          return {
            start,
            end,
            disabled: value.slice(start, end).includes('\u0336'),
            x: Math.max(8, Math.min(event.clientX, window.innerWidth - 180)),
            y: Math.max(8, Math.min(event.clientY, window.innerHeight - 48))
          }
        }
      }
      return null
    }
    const move = (event: MouseEvent): void => setHover(locate(event))
    const context = (event: MouseEvent): void => {
      const tag = locate(event)
      if (!tag) return
      event.preventDefault()
      setMenu(tag)
    }
    ta.addEventListener('contextmenu', context)
    ta.addEventListener('mousemove', move)
    ta.addEventListener('mouseleave', leave)
    ta.addEventListener('scroll', sync)
    ta.addEventListener('keydown', sync)
    sync()
    return () => {
      ta.removeEventListener('contextmenu', context)
      ta.removeEventListener('mousemove', move)
      ta.removeEventListener('mouseleave', leave)
      ta.removeEventListener('scroll', sync)
      ta.removeEventListener('keydown', sync)
    }
  }, [value, textarea])
  return (
    <>
      <div
        ref={mirror}
        aria-hidden
        className={`${typography} pointer-events-none absolute inset-0 overflow-hidden text-ink`}
      >
        {tags.map((tag, i) => (
          <span key={tag.start}>
            {syntaxDisplay(i ? tags[i - 1].end : 0, tag.start)}
            <span
              data-tag-start={tag.start}
              data-tag-end={tag.end}
              style={{
                background: tag.disabled
                  ? 'var(--prompt-tag-disabled-bg)'
                  : hover?.start === tag.start
                    ? 'var(--prompt-tag-hover-bg)'
                    : undefined,
                color: tag.disabled ? 'var(--prompt-tag-disabled-ink)' : undefined,
                boxDecorationBreak: 'clone'
              }}
            >
              {display(value.slice(tag.start, tag.end))}
            </span>
          </span>
        ))}
        {syntaxDisplay(tags.length ? tags[tags.length - 1].end : 0, value.length)}
      </div>
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-[100] min-w-[150px] rounded-lg border border-line bg-surface p-1 text-ink shadow-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              autoFocus
              role="menuitem"
              className="w-full rounded-sm px-3 py-1.5 text-left text-[12.5px] hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
              onClick={() => {
                onValueChange(togglePromptTag(value, menu.start, menu.end))
                setMenu(null)
                textarea.current?.focus()
              }}
            >
              {t(menu.disabled ? 'ui.enablePromptTag' : 'ui.disablePromptTag')}
            </button>
          </div>,
          document.body
        )}
    </>
  )
}
