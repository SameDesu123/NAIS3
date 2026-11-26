import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import { analyzePromptTags, maskPromptComments } from '@shared/prompt-tags'
import { flushSync } from 'react-dom'
import { useT } from '../lib/i18n'
import { applyPromptTagToggle } from '../lib/prompt-tag-edit'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem
} from './ui/context-menu'

function syncScroll(mirror: HTMLDivElement | null, textarea: HTMLTextAreaElement | null): void {
  if (!mirror || !textarea) return
  mirror.scrollTop = textarea.scrollTop
  mirror.scrollLeft = textarea.scrollLeft
}

export function PromptTagHover({
  value,
  onValueChange,
  textarea,
  typography,
  children
}: {
  value: string
  onValueChange: (value: string) => void
  textarea: RefObject<HTMLTextAreaElement | null>
  typography: string
  children?: ReactNode
}): React.JSX.Element {
  const t = useT()
  const mirror = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ start: number; end: number; disabled: boolean } | null>(null)
  const open = useRef(false)
  const pendingToggle = useRef<typeof menu>(null)
  const analysis = useMemo(() => analyzePromptTags(value), [value])
  const display = (text: string): string => text.replaceAll('\u0336', '\u2060')
  const masked = useMemo(() => maskPromptComments(value), [value])
  useLayoutEffect(() => syncScroll(mirror.current, textarea.current), [textarea, value])
  useEffect(() => {
    const ta = textarea.current
    if (!ta) return
    const sync = (): void => syncScroll(mirror.current, ta)
    const observer = new ResizeObserver(sync)
    observer.observe(ta)
    const scroll = (): void => {
      sync()
      setHover(null)
    }
    ta.addEventListener('scroll', scroll)
    return () => {
      observer.disconnect()
      ta.removeEventListener('scroll', scroll)
    }
  }, [textarea])
  const locate = (x: number, y: number): typeof menu => {
    for (const span of mirror.current?.querySelectorAll<HTMLElement>('[data-tag-start]') ?? []) {
      if (
        Array.from(span.getClientRects()).some(
          (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
        )
      ) {
        const start = Number(span.dataset.tagStart)
        return analysis.tags.find((tag) => tag.start === start) ?? null
      }
    }
    return null
  }
  const syntax = (start: number, end: number): ReactNode => {
    const points = new Set([start, end])
    for (const group of analysis.disabledGroups) {
      if (group.start > start && group.start < end) points.add(group.start)
      if (group.end > start && group.end < end) points.add(group.end)
    }
    const sorted = [...points].sort((a, b) => a - b)
    return sorted.slice(0, -1).map((point, i) => (
      <span
        key={point}
        style={
          analysis.disabledGroups.some((g) => point >= g.start && point < g.end)
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
  return (
    <ContextMenu
      onOpenChange={(isOpen) => {
        open.current = isOpen
        if (!isOpen) setMenu(null)
      }}
    >
      <div
        ref={mirror}
        aria-hidden
        data-prompt-tag-mirror
        className={typography + ' pointer-events-none absolute inset-0 overflow-hidden text-ink'}
      >
        {analysis.tags.map((tag, i) => (
          <span key={tag.start}>
            {syntax(i ? analysis.tags[i - 1].end : 0, tag.start)}
            <span>
              {display(value.slice(tag.start, tag.end))
                .split('\n')
                .map((line, index, lines) => {
                  const comment =
                    masked.slice(tag.start, tag.end).split('\n')[index]?.trim() === '' &&
                    line.trim() !== ''
                  return (
                    <span
                      key={index}
                      data-tag-start={comment ? undefined : tag.start}
                      data-tag-end={comment ? undefined : tag.end}
                      style={
                        comment
                          ? undefined
                          : {
                              background: tag.disabled
                                ? 'var(--prompt-tag-disabled-bg)'
                                : hover === tag.start
                                  ? 'var(--prompt-tag-hover-bg)'
                                  : undefined,
                              color: tag.disabled ? 'var(--prompt-tag-disabled-ink)' : undefined,
                              boxDecorationBreak: 'clone'
                            }
                      }
                    >
                      {line}
                      {index < lines.length - 1 ? '\n' : ''}
                    </span>
                  )
                })}
            </span>
          </span>
        ))}
        {syntax(
          analysis.tags.length ? analysis.tags[analysis.tags.length - 1].end : 0,
          value.length
        )}
        {value.endsWith('\n') && '\u200b'}
      </div>
      <ContextMenuTrigger asChild disabled={hover === null && menu === null}>
        <div
          className="contents"
          onMouseMove={(event) => {
            if (open.current) return
            const next = locate(event.clientX, event.clientY)?.start ?? null
            setHover((current) => (current === next ? current : next))
          }}
          onMouseLeave={() => {
            if (!open.current) setHover(null)
          }}
          onContextMenuCapture={(event) => {
            const target =
              event.clientX === 0 && event.clientY === 0
                ? (analysis.tags.find(
                    (tag) =>
                      textarea.current &&
                      tag.start <= textarea.current.selectionStart &&
                      tag.end >= textarea.current.selectionStart
                  ) ?? null)
                : locate(event.clientX, event.clientY)
            flushSync(() => {
              setMenu(target)
              setHover(target?.start ?? null)
            })
          }}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      {menu && (
        <ContextMenuContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            requestAnimationFrame(() => {
              const ta = textarea.current
              const target = pendingToggle.current
              pendingToggle.current = null
              if (!ta) return
              ta.focus()
              if (target) applyPromptTagToggle(ta, value, target.start, target.end, onValueChange)
            })
          }}
        >
          <ContextMenuItem
            onSelect={() => {
              pendingToggle.current = menu
            }}
          >
            {t(menu.disabled ? 'ui.enablePromptTag' : 'ui.disablePromptTag')}
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  )
}
