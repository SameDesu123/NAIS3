import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
  Globe,
  Image,
  ImageUp,
  Layers,
  LayoutGrid,
  Library,
  PanelLeft,
  PanelRight,
  Puzzle,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  UsersRound,
  Wand2,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { SUPPORTED_LANGUAGES, translate, type MessageId } from '@shared/i18n'
import { rankByQuery } from '../lib/command-search'
import { useT } from '../lib/i18n'
import { cn } from '../lib/utils'
import { useCommandBarStore } from '../stores/command-bar-store'
import { useLayoutStore, type CenterMode } from '../stores/layout-store'
import {
  formatCombo,
  runAction,
  SHORTCUT_LABELS,
  useShortcutsStore,
  type ShortcutAction
} from '../stores/shortcuts-store'

export interface Command {
  id: string
  label: MessageId
  icon: LucideIcon
  /** 같은 일을 하는 단축키 — 옆에 키 조합을 보여 준다 */
  shortcut?: ShortcutAction
  /** 상단 탭에서 숨길 수 있는 페이지로 가는 명령이면 그 페이지 */
  page?: CenterMode
  run: () => void
}

const ICONS: Record<Exclude<ShortcutAction, 'openCommandBar'>, LucideIcon> = {
  generate: Sparkles,
  toggleLeft: PanelLeft,
  toggleRight: PanelRight,
  openSettings: Settings,
  modeMain: Image,
  modeScene: LayoutGrid,
  modeDirector: Wand2,
  openCharacter: UsersRound,
  openFragment: Puzzle,
  openVibe: Layers,
  openCharRef: ImageUp,
  openParams: SlidersHorizontal,
  resetFragmentCounters: RotateCcw
}

const SHORTCUT_PAGES: Partial<Record<ShortcutAction, CenterMode>> = {
  modeScene: 'scene',
  modeDirector: 'director'
}

/** 단축키 액션 전부 + 단축키가 없는 페이지 전환 */
const COMMANDS: Command[] = [
  ...(Object.keys(ICONS) as (keyof typeof ICONS)[]).map((action): Command => ({
    id: action,
    label: SHORTCUT_LABELS[action],
    icon: ICONS[action],
    shortcut: action,
    page: SHORTCUT_PAGES[action],
    run: () => runAction(action)
  })),
  {
    id: 'modeLibrary',
    label: 'ui.libraryMode',
    icon: Library,
    page: 'library',
    run: () => useLayoutStore.getState().setCenterMode('library')
  },
  {
    id: 'modeWeb',
    label: 'ui.webMode',
    icon: Globe,
    page: 'websearch',
    run: () => useLayoutStore.getState().setCenterMode('websearch')
  }
]

/**
 * 등록된 모든 언어의 라벨로 찾는다 — 영어 화면에서 "ㅅㅈ"이나 "설정"으로, 한국어 화면에서
 * "settings"로 쳐도 나온다. 카탈로그는 바뀌지 않으니 명령마다 한 번만 모은다
 */
const searchTextCache = new Map<MessageId, string[]>()
function searchTexts(command: Command): string[] {
  let texts = searchTextCache.get(command.label)
  if (!texts) {
    texts = [...new Set(SUPPORTED_LANGUAGES.map((lang) => translate(lang, command.label, [])))]
    searchTextCache.set(command.label, texts)
  }
  return texts
}

/**
 * 빠른 명령 검색 (기본 Mod+K). 명령을 고르면 바를 닫고, 포커스를 바를 연 자리로 돌려준 뒤에 실행한다 —
 * 설정처럼 다른 대화상자를 여는 명령이 포커스 복원과 엇갈리지 않게.
 */
export function CommandBar(): React.JSX.Element {
  const t = useT()
  const open = useCommandBarStore((s) => s.open)
  const setOpen = useCommandBarStore((s) => s.setOpen)
  const pending = useRef<Command | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)

  function choose(command: Command): void {
    pending.current = command
    setOpen(false)
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[16vh] z-50 flex max-h-[68vh] w-[calc(100%-2rem)] max-w-[560px] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-surface text-ink shadow-2xl outline-none"
          onOpenAutoFocus={() => {
            // 아직 입력창으로 옮기기 전 — 바를 연 자리
            const active = document.activeElement
            returnFocus.current = active instanceof HTMLElement ? active : null
          }}
          onCloseAutoFocus={(e) => {
            // Radix는 Trigger로만 포커스를 돌려준다. 단축키로 여는 바엔 Trigger가 없으니 직접 돌려준다
            e.preventDefault()
            const target = returnFocus.current
            returnFocus.current = null
            if (target?.isConnected) target.focus({ preventScroll: true })
            const command = pending.current
            pending.current = null
            command?.run()
          }}
        >
          <DialogPrimitive.Title className="sr-only">{t('ui.commandBar')}</DialogPrimitive.Title>
          <CommandBarBody onChoose={choose} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function CommandBarBody({ onChoose }: { onChoose: (command: Command) => void }): React.JSX.Element {
  const t = useT()
  const bindings = useShortcutsStore((s) => s.bindings)
  const hiddenPages = useLayoutStore((s) => s.hiddenPages)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()

  const results = useMemo(() => {
    const available = COMMANDS.filter((c) => !c.page || !hiddenPages.includes(c.page))
    return rankByQuery(available, query, searchTexts)
  }, [hiddenPages, query])
  const current = results[Math.min(active, results.length - 1)]
  const optionId = (command: Command): string => `${listId}-${command.id}`
  const currentId = current ? optionId(current) : undefined

  useEffect(() => {
    if (currentId) document.getElementById(currentId)?.scrollIntoView?.({ block: 'nearest' })
  }, [currentId])

  function move(delta: number): void {
    if (results.length === 0) return
    const from = Math.min(active, results.length - 1)
    setActive((from + delta + results.length) % results.length)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    // 한글 조합 중의 Enter·화살표는 IME가 글자를 확정하는 데 쓴다
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
      e.preventDefault()
      // 라이트박스처럼 window에서 화살표를 듣는 화면이 뒤에서 같이 움직이지 않게
      e.stopPropagation()
      if (e.key === 'Enter') {
        if (current) onChoose(current)
      } else {
        move(e.key === 'ArrowDown' ? 1 : -1)
      }
    } else if (e.key === 'Escape') {
      // 닫기는 Radix가 한다. 뒤에 깔린 라이트박스까지 닫히지 않게만 막는다
      e.stopPropagation()
    }
  }

  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <Search size={16} className="shrink-0 text-muted" aria-hidden />
        <input
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={currentId}
          aria-label={t('ui.commandBarPlaceholder')}
          placeholder={t('ui.commandBarPlaceholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          className="h-12 min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-faint"
        />
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label={t('ui.commandBar')}
        className={cn('min-h-0 overflow-y-auto p-1.5', results.length === 0 && 'hidden')}
      >
        {results.map((command) => {
          const Icon = command.icon
          const selected = command === current
          return (
            <li
              key={command.id}
              id={optionId(command)}
              role="option"
              aria-selected={selected}
              // 입력창 포커스를 지킨다
              onMouseDown={(e) => e.preventDefault()}
              // pointerenter가 아니라 move — 키보드로 목록이 스크롤될 때 커서 밑 항목이 선택을 빼앗지 않게
              onPointerMove={() => {
                if (!selected) setActive(results.indexOf(command))
              }}
              onClick={() => onChoose(command)}
              className={cn(
                'flex cursor-default select-none items-center gap-3 rounded-lg px-3 py-2 text-[13px]',
                selected ? 'bg-accent/10 text-accent-ink' : 'text-ink'
              )}
            >
              <Icon size={15} className={cn('shrink-0', !selected && 'text-muted')} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{t(command.label)}</span>
              {command.shortcut && bindings[command.shortcut] && (
                <kbd className="shrink-0 font-mono text-[11px] text-faint">
                  {formatCombo(bindings[command.shortcut])}
                </kbd>
              )}
            </li>
          )
        })}
      </ul>
      {results.length === 0 && (
        <p aria-hidden className="px-4 py-6 text-center text-[12.5px] text-muted">
          {t('ui.commandBarNoResults')}
        </p>
      )}
      <div role="status" className="sr-only">
        {query.trim() === ''
          ? ''
          : results.length > 0
            ? t('ui.commandBarResultCount', results.length)
            : t('ui.commandBarNoResults')}
      </div>
    </>
  )
}
