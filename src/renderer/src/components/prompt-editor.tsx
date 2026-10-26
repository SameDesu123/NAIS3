import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MessageId } from '@shared/i18n'
import { cn } from '../lib/utils'
import { useT } from '../lib/i18n'
import { caretCoords } from '../lib/caret'
import {
  autocompleteKeyAction,
  isCaretInToken,
  NO_SELECTION,
  TAG_TOKEN_SEPARATORS,
  type SuggestionKind
} from '../lib/autocomplete'
import { highlightRanges } from '../lib/prompt-weights'
import { fragmentAtSelection, fragmentPaths, useFragmentsStore } from '../stores/fragments-store'

/**
 * 프롬프트 에디터.
 *
 * 하이라이트 구조 (NAIS2의 커서/드래그 어긋남 문제를 피하는 설계):
 * - 글자는 textarea가 "단독으로" 그린다 — 선택·커서·IME 전부 네이티브 동작
 * - 미러(div)는 동일 타이포로 투명 글자를 깔고 배경색만 칠한다
 * - 테두리는 컨테이너가 가진다 (textarea/미러 metrics 완전 동일 보장)
 *
 * 색: 강조({}·양수 가중치)=붉은색, 약화([]·1 미만·음수)=파란색, <조각>=녹색
 * 자동완성: 커서 바로 아래 팝업. `<`는 조각, 그 외 토큰은 단부루 태그(IPC 검색)
 */

// 폰트 크기는 설정값(--prompt-size)을 따름. mirror/textarea가 동일해야 배경 정렬이 맞는다.
// scrollbar-gutter:stable — 스크롤바 자리를 미리 배정(mirror도 동일해야 정렬 유지)
const TYPO =
  'whitespace-pre-wrap break-words p-2.5 font-mono text-[length:var(--prompt-size,15px)] leading-relaxed [scrollbar-gutter:stable]'

type Suggestion =
  { kind: 'frag'; path: string } | { kind: 'tag'; tag: string; count: number; type: string }

function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return String(count)
}

const TYPE_COLORS: Record<string, string> = {
  artist: 'text-tag-artist',
  character: 'text-tag-character',
  copyright: 'text-tag-copyright',
  meta: 'text-tag-meta'
}

// 종류는 색만으로 구분하지 않는다 (WCAG 1.4.1) — 색각 이상·스크린 리더용 글자 표시
const TYPE_LABELS = {
  artist: 'ui.tagTypeArtist',
  character: 'ui.tagTypeCharacter',
  copyright: 'ui.tagTypeCopyright',
  meta: 'ui.tagTypeMeta',
  general: 'ui.tagTypeGeneral'
} as const satisfies Record<string, MessageId>

function typeLabelId(type: string): MessageId | null {
  return type in TYPE_LABELS ? TYPE_LABELS[type as keyof typeof TYPE_LABELS] : null
}

/*
 * Find highlights. In some themes the fill alone barely differs in luminance from the surface,
 * so also draw a line with guaranteed contrast (current = ink outline, others = ink underline).
 * box-decoration-break: clone draws the line on every fragment split by line wraps.
 */
const FIND_HIT_BASE: React.CSSProperties = {
  borderRadius: 3,
  boxDecorationBreak: 'clone',
  WebkitBoxDecorationBreak: 'clone'
}
const FIND_HIT_STYLE: React.CSSProperties = {
  ...FIND_HIT_BASE,
  background: 'var(--search-hit)',
  boxShadow: 'inset 0 -2px 0 var(--ink)'
}
const FIND_HIT_CURRENT_STYLE: React.CSSProperties = {
  ...FIND_HIT_BASE,
  background: 'var(--search-hit-current)',
  boxShadow: '0 0 0 1.5px var(--ink)'
}

export function PromptEditor({
  value,
  onValueChange,
  placeholder,
  className,
  ariaLabel,
  negative = false,
  tokensOverride,
  tokenModel,
  tokenLimit = 512
}: {
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  className?: string
  ariaLabel?: string
  negative?: boolean
  /** 외부에서 합산한 토큰 수 (기본+캐릭터 합산 등). undefined면 자체 카운트, null이면 숨김 */
  tokensOverride?: number | null
  /** 자체 카운트에 사용할 모델. 생략하면 자체 카운트를 숨김 */
  tokenModel?: string
  tokenLimit?: number
}): React.JSX.Element {
  const t = useT()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  // 검색 세대 — 이미 날아간(in-flight) 태그 검색의 스테일 결과가 뒤늦게 패널을 다시 여는 것 방지.
  // (패널이 남으면 Enter가 줄바꿈 대신 자동완성 삽입으로 먹혀 "줄바꿈이 안 된다"로 나타남)
  const searchSeqRef = useRef(0)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  // -1 = 미선택. ↑/↓·마우스로 고른 항목만 Enter로 삽입된다 (lib/autocomplete)
  const [selected, setSelected] = useState(NO_SELECTION)
  // 토큰 시작·종류는 ref — onSelect가 같은 이벤트 루프에서 onChange 직후 읽어도 최신이어야 함
  const tokenRef = useRef<{ start: number; kind: SuggestionKind }>({ start: -1, kind: 'tag' })
  // complete()의 execCommand가 일으킨 onChange에서 추천을 다시 열지 않기 위한 플래그
  const completingRef = useRef(false)
  // 팝업 기준점 (뷰포트 좌표). 실제 위치는 렌더 후 팝업 크기를 재서 정한다 (useLayoutEffect)
  const [popupAnchor, setPopupAnchor] = useState<{
    left: number
    below: number
    above: number
  } | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  // 스크린 리더 안내 (aria-live) — 목록 열림·삽입 결과
  const [announcement, setAnnouncement] = useState('')
  const listboxId = useId()
  const optionId = (i: number): string => `${listboxId}-${i}`
  const popupOpen = suggestions.length > 0 && popupAnchor !== null

  function typeLabel(type: string): string | null {
    const id = typeLabelId(type)
    return id ? t(id) : null
  }

  /** 스크린 리더가 읽을 항목 이름 — 화면의 색·약식 숫자 대신 종류와 게시물 수를 말로 */
  function optionLabel(s: Suggestion): string {
    if (s.kind === 'frag') return `<${s.path}>, ${t('ui.fragments')}`
    return [s.tag, typeLabel(s.type), t('ui.valuePosts', formatCount(s.count))]
      .filter(Boolean)
      .join(', ')
  }

  const ranges = useMemo(() => highlightRanges(value), [value])

  // 토큰 카운트 (V5=Qwen 3.5, 이전 모델=T5 — 주석·조각 전처리는 메인 IPC에서 적용)
  const [ownTokens, setOwnTokens] = useState<number | null>(null)
  const external = tokensOverride !== undefined
  useEffect(() => {
    if (external) return
    if (!tokenModel || !value.trim()) {
      const timer = setTimeout(() => setOwnTokens(null))
      return () => clearTimeout(timer)
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void window.nais
        .invoke('tokens:count', { texts: [value], model: tokenModel })
        .then(({ counts }) => {
          if (!cancelled) setOwnTokens(counts[0])
        })
        .catch(() => {
          if (!cancelled) setOwnTokens(null)
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [value, external, tokenModel])
  const tokens = external ? tokensOverride : tokenModel && value.trim() ? ownTokens : null

  // 세로 스크롤바가 생기면 textarea 콘텐츠 폭이 줄어 줄바꿈이 달라진다 —
  // 미러의 오른쪽을 스크롤바 폭만큼 좁혀 두 레이어의 줄바꿈을 항상 일치시킨다
  // 스크롤바 폭 보정은 하지 않는다 — mirror·textarea 둘 다 scrollbar-gutter:stable(TYPO)이라
  // 콘텐츠 폭이 항상 동일. 수동 right 보정을 더하면 이중 인셋으로 줄바꿈이 어긋난다(배경 오정렬).
  const syncScroll = (): void => {
    const ta = textareaRef.current
    if (!ta) return
    for (const mirror of [mirrorRef.current, findMirrorRef.current]) {
      if (!mirror) continue
      mirror.scrollTop = ta.scrollTop
      mirror.scrollLeft = ta.scrollLeft
    }
  }
  useEffect(syncScroll, [value])
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const observer = new ResizeObserver(syncScroll)
    observer.observe(ta)
    return () => observer.disconnect()
  }, [])

  // 찾기 (Ctrl/Cmd+F) — 대소문자 무시, 일치 전부 하이라이트 + Enter로 순회
  const findMirrorRef = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hit, setHit] = useState(0)
  const hits = useMemo(() => {
    if (!findOpen || !query) return []
    const needle = query.toLowerCase()
    const hay = value.toLowerCase()
    const out: number[] = []
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
      out.push(i)
    }
    return out
  }, [findOpen, query, value])
  // 글자를 지워 일치 수가 줄면 현재 위치가 범위를 벗어난다
  const current = hits.length === 0 ? -1 : Math.min(hit, hits.length - 1)

  /** 현재 일치가 화면 밖이면 그 줄이 보이도록 스크롤 */
  function revealHit(index: number): void {
    const ta = textareaRef.current
    if (!ta || index < 0 || hits[index] == null) return // 0번째 글자 일치도 유효 (falsy 주의)
    const { top, height } = caretCoords(ta, hits[index])
    if (top < ta.scrollTop || top + height > ta.scrollTop + ta.clientHeight) {
      ta.scrollTop = Math.max(0, top - ta.clientHeight / 2)
      syncScroll()
    }
  }

  function step(delta: number): void {
    if (hits.length === 0) return
    const next = (current + delta + hits.length) % hits.length
    setHit(next)
    requestAnimationFrame(() => revealHit(next))
  }

  function openFind(): void {
    const ta = textareaRef.current
    // 드래그해 둔 글자가 있으면 그걸 찾는 말로 (에디터 공통 관례)
    const selected = ta ? value.slice(ta.selectionStart, ta.selectionEnd) : ''
    if (selected && !selected.includes('\n')) setQuery(selected)
    setHit(0)
    setFindOpen(true)
    closeSuggestions()
    requestAnimationFrame(() => findInputRef.current?.select())
  }

  function closeFind(): void {
    setFindOpen(false)
    const ta = textareaRef.current
    ta?.focus()
    // 찾던 자리에 커서를 두고 닫는다 — 바로 이어서 고칠 수 있게
    if (ta && current >= 0) {
      const start = hits[current]
      ta.setSelectionRange(start, start + query.length)
    }
  }

  // 일치 위치가 바뀌면(입력·타이핑) 현재 항목이 보이게
  useEffect(() => {
    if (findOpen && current >= 0) revealHit(current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, current, query])

  /** 커서 위치를 팝업 기준점으로 (뷰포트 기준) */
  function placePopup(): void {
    const ta = textareaRef.current
    if (!ta) return
    const caret = caretCoords(ta, ta.selectionStart)
    const rect = ta.getBoundingClientRect()
    const top = rect.top + caret.top - ta.scrollTop
    setPopupAnchor({
      left: rect.left + caret.left - ta.scrollLeft,
      below: top + caret.height + 4,
      above: top - 4
    })
  }

  // 팝업의 실제 크기로 위치 결정 — 항목 높이를 어림하면 글자 크기·확대 배율에 따라 화면 밖으로 나간다.
  // 아래가 모자라면 커서 위로. 양쪽 다 모자라면 넓은 쪽에 붙이고 높이를 줄여 목록 안에서 스크롤
  // (화면 끝에 클램프하면 커서 줄을 덮는다). 좌우는 화면 안으로 클램프. 페인트 전이라 깜빡임 없음
  useLayoutEffect(() => {
    const el = popupRef.current
    if (!el || !popupAnchor) return
    el.style.maxHeight = ''
    const { offsetWidth: width, offsetHeight: height } = el
    const spaceBelow = window.innerHeight - 8 - popupAnchor.below
    const spaceAbove = popupAnchor.above - 8
    let top = popupAnchor.below
    if (height > spaceBelow) {
      if (height <= spaceAbove) {
        top = popupAnchor.above - height
      } else if (spaceAbove > spaceBelow) {
        top = 8
        el.style.maxHeight = `${spaceAbove}px`
      } else {
        el.style.maxHeight = `${Math.max(spaceBelow, 0)}px`
      }
    }
    el.style.left = `${Math.max(8, Math.min(popupAnchor.left, window.innerWidth - width - 8))}px`
    el.style.top = `${top}px`
  }, [popupAnchor, suggestions])

  // 높이가 줄어 스크롤되는 목록에서 ↑/↓로 고른 항목이 가려지지 않게
  useLayoutEffect(() => {
    if (selected < 0) return
    document.getElementById(`${listboxId}-${selected}`)?.scrollIntoView({ block: 'nearest' })
  }, [selected, listboxId])

  // 목록이 열리거나 항목 수가 바뀌면 안내. 선택 이동은 aria-activedescendant로 읽힌다
  const suggestionCount = popupAnchor ? suggestions.length : 0
  useEffect(() => {
    if (suggestionCount === 0) return
    const timer = setTimeout(() =>
      setAnnouncement(t('ui.valueSuggestionsUpDownToChooseTabToInsert', suggestionCount))
    )
    return () => clearTimeout(timer)
  }, [suggestionCount, t])

  /** 추천 닫기. seq를 올리고 debounce를 취소해 이미 출발한 검색이 패널을 되열지 못하게 (B7) */
  function closeSuggestions(): void {
    clearTimeout(debounceRef.current)
    searchSeqRef.current++
    tokenRef.current.start = -1
    setSuggestions([])
    setSelected(NO_SELECTION)
  }

  function refreshSuggestions(text: string, cursor: number): void {
    clearTimeout(debounceRef.current)
    const seq = ++searchSeqRef.current // 이 시점 이전에 발사된 검색 결과는 전부 무효
    const before = text.slice(0, cursor)
    tokenRef.current.start = -1
    // 입력이 바뀌면 고른 항목도 무효 — 새 결과가 오기 전(debounce+IPC) Enter가 이전 목록의
    // 선택을 새 토큰에 넣지 않게. "blue"에서 ↓로 blue hair → " ey" 입력 → Enter = blue hair
    setSelected(NO_SELECTION)

    // 주석 구간(# 뒤)에서는 추천 안 함 — 어차피 전송 안 되는 텍스트
    const lineStart = before.lastIndexOf('\n') + 1
    if (before.slice(lineStart).includes('#')) {
      setSuggestions([])
      return
    }

    const frag = /<([^<>|]*)$/.exec(before)
    if (frag) {
      const paths = fragmentPaths(frag[1])
      tokenRef.current = { start: cursor - frag[1].length, kind: 'frag' }
      setSuggestions(paths.map((path) => ({ kind: 'frag', path })))
      setSelected(NO_SELECTION)
      if (paths.length > 0) placePopup()
      return
    }

    let sepIdx = -1
    for (let i = before.length - 1; i >= 0; i--) {
      if (TAG_TOKEN_SEPARATORS.test(before[i])) {
        sepIdx = i
        break
      }
    }
    const rawToken = before.slice(sepIdx + 1)
    const token = rawToken.trimStart()
    const start = sepIdx + 1 + (rawToken.length - token.length)
    if (token.trim().length < 2) {
      setSuggestions([])
      return
    }
    tokenRef.current = { start, kind: 'tag' }
    debounceRef.current = setTimeout(() => {
      void window.nais
        .invoke('tags:search', { query: token.trim(), limit: 8 })
        .then(({ items }) => {
          if (searchSeqRef.current !== seq) return // 스테일 — 그 사이 입력이 바뀜
          setSuggestions(items.map((t) => ({ kind: 'tag' as const, ...t })))
          setSelected(NO_SELECTION)
          if (items.length > 0) placePopup()
        })
    }, 90)
  }

  /** 커서가 토큰을 벗어났으면(클릭·방향키·Home/End·드래그) 추천을 즉시 닫는다 */
  function checkCaret(): void {
    const ta = textareaRef.current
    const { start, kind } = tokenRef.current
    if (!ta || start < 0) return
    if (!isCaretInToken(ta.value, start, ta.selectionStart, ta.selectionEnd, kind)) {
      closeSuggestions()
    }
  }

  function complete(s: Suggestion): void {
    const ta = textareaRef.current
    const { start, kind } = tokenRef.current
    if (!ta || start < 0) return
    // 방어: 목록이 뜬 뒤 커서가 움직였다면 삽입하면 글이 지워지거나 중복된다 — 닫기만
    const text = ta.value
    if (!isCaretInToken(text, start, ta.selectionStart, ta.selectionEnd, kind)) {
      closeSuggestions()
      return
    }
    const cursor = ta.selectionStart
    let insert = s.kind === 'frag' ? s.path + '>' : s.tag
    // 완성 후 바로 다음 태그를 이어 칠 수 있게 ", " 부착 (뒤에 이미 쉼표가 있으면 생략)
    if (!text.slice(cursor).trimStart().startsWith(',')) insert += ', '
    closeSuggestions()
    // Tab은 포커스 이동이 아니라 삽입이므로 무엇이 들어갔는지 알린다
    setAnnouncement(t('ui.insertedValue', s.kind === 'frag' ? `<${s.path}>` : s.tag))

    // value를 프로그램적으로 바꾸면 Chromium이 textarea의 네이티브 undo 기록을 통째로 버린다
    // (Ctrl+Z로 자동완성 이전 입력까지 못 되돌림). execCommand('insertText')는 deprecated지만
    // 사용자 입력과 같은 편집으로 undo 스택에 쌓이는 유일한 수단 — Ctrl+Z 한 번이면 완성 직전.
    // input 이벤트가 나서 onChange → onValueChange로 값이 동기화된다.
    ta.focus()
    ta.setSelectionRange(start, cursor)
    completingRef.current = true
    let inserted = false
    try {
      inserted = document.execCommand('insertText', false, insert)
    } finally {
      completingRef.current = false
    }
    if (inserted) return

    // 대체 경로 (execCommand 미지원) — undo 기록은 잃는다
    onValueChange(text.slice(0, start) + insert + text.slice(cursor))
    requestAnimationFrame(() => {
      const pos = start + insert.length
      ta.setSelectionRange(pos, pos)
      ta.focus()
    })
  }

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-md border border-line bg-paper transition-colors',
        negative && 'border-danger/25',
        className
      )}
    >
      <div
        ref={mirrorRef}
        aria-hidden
        className={cn(
          TYPO,
          'pointer-events-none absolute inset-0 overflow-hidden text-transparent'
        )}
      >
        {ranges.map((r) =>
          r.bg ? (
            <span key={r.start} style={{ background: r.bg, borderRadius: 3 }}>
              {value.slice(r.start, r.end)}
            </span>
          ) : (
            <span key={r.start}>{value.slice(r.start, r.end)}</span>
          )
        )}
        {value.endsWith('\n') && '​'}
      </div>

      {/* 찾기 하이라이트 — 가중치 미러 위에 한 겹 더 (글자는 투명, 배경만) */}
      {findOpen && hits.length > 0 && (
        <div
          ref={findMirrorRef}
          aria-hidden
          className={cn(
            TYPO,
            'pointer-events-none absolute inset-0 overflow-hidden text-transparent'
          )}
        >
          {hits.map((start, i) => (
            <span key={start}>
              {value.slice(i === 0 ? 0 : hits[i - 1] + query.length, start)}
              <span style={i === current ? FIND_HIT_CURRENT_STYLE : FIND_HIT_STYLE}>
                {value.slice(start, start + query.length)}
              </span>
            </span>
          ))}
          {value.slice(hits[hits.length - 1] + query.length)}
        </div>
      )}

      <textarea
        ref={textareaRef}
        aria-label={ariaLabel}
        className={cn(
          TYPO,
          'relative block h-full w-full resize-none bg-transparent text-ink outline-none placeholder:text-muted'
        )}
        style={{ caretColor: 'var(--ink)' }}
        spellCheck={false}
        // 자동완성 목록 연결. 포커스는 textarea에 둔 채 activedescendant로 선택 항목을 읽힌다.
        // (textarea는 combobox 역할을 가질 수 없어 textbox + aria-autocomplete 조합)
        aria-autocomplete="list"
        aria-controls={popupOpen ? listboxId : undefined}
        aria-activedescendant={
          popupOpen && selected >= 0 && selected < suggestions.length
            ? optionId(selected)
            : undefined
        }
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onValueChange(e.target.value)
          // 자동완성 삽입 자체가 일으킨 변경 — 뒤에 쉼표가 있어 ", "를 안 붙인 경우
          // 방금 넣은 태그로 목록이 다시 뜨는 것 방지
          if (completingRef.current) return
          refreshSuggestions(e.target.value, e.target.selectionStart)
        }}
        onSelect={checkCaret}
        onScroll={syncScroll}
        onDoubleClick={(e) => {
          const ta = e.currentTarget
          const fragment = fragmentAtSelection(value, ta.selectionStart, ta.selectionEnd)
          if (!fragment) return
          closeSuggestions()
          useFragmentsStore.getState().openEditor(fragment.id)
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault()
            e.stopPropagation()
            openFind()
            return
          }
          if (e.key === 'Escape' && findOpen) {
            e.preventDefault()
            e.stopPropagation()
            closeFind()
            return
          }
          const action = autocompleteKeyAction({
            key: e.key,
            count: suggestions.length,
            selected,
            composing: e.nativeEvent.isComposing || e.keyCode === 229,
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            altKey: e.altKey
          })
          if (action.type === 'select') {
            e.preventDefault()
            setSelected(action.index)
          } else if (action.type === 'complete') {
            e.preventDefault()
            complete(suggestions[action.index])
          } else if (action.type === 'close') {
            closeSuggestions() // preventDefault 안 함 — 줄바꿈 등 기본 동작 유지
          } else if (action.type === 'dismiss') {
            e.preventDefault()
            e.stopPropagation()
            closeSuggestions()
          }
        }}
        onBlur={() => {
          // 포커스가 떠나면 추천 닫기. seq를 올려 in-flight 검색 결과가 뒤늦게 패널을
          // 되열지 못하게 한다 (B7). 150ms 지연은 추천 클릭이 blur보다 먼저 처리되도록.
          clearTimeout(debounceRef.current)
          searchSeqRef.current++
          tokenRef.current.start = -1
          setTimeout(() => setSuggestions([]), 150)
        }}
      />

      {/* 찾기 바 — 우상단. Enter=다음, Shift+Enter=이전, Esc=닫기(그 자리에 커서) */}
      {findOpen && (
        <div
          data-prompt-find
          className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1 rounded-md border border-line bg-paper/95 p-1 shadow-lg backdrop-blur-sm"
        >
          <Search size={12} className="ml-0.5 shrink-0 text-faint" />
          <input
            ref={findInputRef}
            className="w-28 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:font-sans placeholder:text-muted"
            placeholder={t('ui.find')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setHit(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                step(e.shiftKey ? -1 : 1)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                closeFind()
              } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
                e.preventDefault()
                e.stopPropagation()
                findInputRef.current?.select()
              }
            }}
          />
          <span className="shrink-0 font-mono text-[10.5px] text-muted">
            {query ? `${hits.length === 0 ? 0 : current + 1}/${hits.length}` : ''}
          </span>
          <button
            className="grid size-5 shrink-0 place-items-center rounded text-faint hover:bg-surface-2 hover:text-ink disabled:opacity-30"
            title={t('ui.previousShiftEnter')}
            disabled={hits.length === 0}
            onClick={() => step(-1)}
          >
            <ChevronUp size={13} />
          </button>
          <button
            className="grid size-5 shrink-0 place-items-center rounded text-faint hover:bg-surface-2 hover:text-ink disabled:opacity-30"
            title={t('ui.nextEnter')}
            disabled={hits.length === 0}
            onClick={() => step(1)}
          >
            <ChevronDown size={13} />
          </button>
          <button
            className="grid size-5 shrink-0 place-items-center rounded text-faint hover:bg-surface-2 hover:text-ink"
            title={t('ui.closeEsc')}
            onClick={closeFind}
          >
            <X size={13} />
          </button>
        </div>
      )}

      {tokens !== null && (
        <span
          className={cn(
            'pointer-events-none absolute bottom-1 right-1.5 rounded bg-paper/85 px-1 font-mono text-[10.5px] backdrop-blur-sm',
            tokens > tokenLimit ? 'text-danger-ink' : 'text-muted'
          )}
          title={
            tokens > tokenLimit
              ? t(
                  'ui.overTheLimitValueValueTokensTheExcessIsCutOffAndNotApplied',
                  tokens,
                  tokenLimit
                )
              : t('ui.valueValueTokens', tokens, tokenLimit)
          }
        >
          {tokens}/{tokenLimit}
        </span>
      )}

      {/* 스크린 리더 안내 — 늘 DOM에 있어야 내용 변경이 읽힌다 */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {popupOpen &&
        popupAnchor &&
        createPortal(
          <div
            ref={popupRef}
            id={listboxId}
            role="listbox"
            aria-label={t('ui.suggestions')}
            data-prompt-suggestions
            className="fixed z-50 min-w-52 max-w-72 overflow-y-auto rounded-md border border-line bg-surface shadow-xl"
            style={{ left: popupAnchor.left, top: popupAnchor.below, pointerEvents: 'auto' }}
          >
            {suggestions.map((s, i) => (
              <div
                key={s.kind === 'frag' ? `f:${s.path}` : `t:${s.tag}`}
                id={optionId(i)}
                role="option"
                aria-selected={i === selected}
                aria-label={optionLabel(s)}
                className={cn(
                  'flex w-full items-center gap-2 px-2.5 py-1 text-left font-mono text-[12px] text-muted',
                  i === selected && 'bg-surface-2 text-ink',
                  // 미선택 상태의 첫 항목 = Tab 기본값 — 배경 없이 좌측 강조선만 약하게
                  selected === NO_SELECTION &&
                    i === 0 &&
                    'text-ink shadow-[inset_2px_0_0_var(--accent)]'
                )}
                // mouseenter 대신 mousemove — 목록이 정지한 포인터 아래에 새로 떴을 때
                // 사용자가 마우스를 움직이지도 않았는데 항목이 "선택"되어 Enter가 먹히는 것 방지
                onMouseMove={() => {
                  if (selected !== i) setSelected(i)
                }}
                onMouseDown={(e) => {
                  e.preventDefault()
                  complete(s)
                }}
              >
                {s.kind === 'frag' ? (
                  <span className="min-w-0 flex-1 truncate text-tag-fragment">{`<${s.path}>`}</span>
                ) : (
                  <>
                    <span className={cn('min-w-0 flex-1 truncate', TYPE_COLORS[s.type])}>
                      {s.tag}
                    </span>
                    {/* 일반 태그는 표시 생략 — 대부분이라 표시하면 오히려 잡음 */}
                    {s.type !== 'general' && typeLabel(s.type) && (
                      <span className="shrink-0 font-sans text-[10.5px] text-muted">
                        {typeLabel(s.type)}
                      </span>
                    )}
                    {/* faint는 밝은 테마의 선택 배경에서 3.8:1 — 작은 글자 기준(4.5:1) 미달이라 muted */}
                    <span className="shrink-0 text-[10.5px] text-muted">
                      {formatCount(s.count)}
                    </span>
                  </>
                )}
                {/* Tab으로 들어갈 항목 — 강조선(색)만이 아니라 글자로도 표시 */}
                {i === (selected === NO_SELECTION ? 0 : selected) && (
                  <kbd
                    aria-hidden
                    className="shrink-0 rounded border border-line px-1 font-sans text-[10px] leading-4 text-muted"
                  >
                    Tab
                  </kbd>
                )}
              </div>
            ))}
          </div>,
          document.body
        )}
    </div>
  )
}
