import {
  ChevronDown,
  ChevronUp,
  ImageUp,
  Layers,
  Minus,
  Plus,
  Puzzle,
  SlidersHorizontal,
  Square,
  UsersRound
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { estimateAnlas } from '@shared/anlas'
import { useCharactersStore } from '../stores/characters-store'
import { useFragmentsStore } from '../stores/fragments-store'
import { useGenerationStore } from '../stores/generation-store'
import { useLayoutStore } from '../stores/layout-store'
import { useCharRefsStore, useVibesStore } from '../stores/refs-store'
import { totalReserved, useScenesStore } from '../stores/scenes-store'
import { PromptEditor } from './prompt-editor'
import { PromptPresetBar } from './prompt-preset-bar'
import { CharacterOverlay } from './character-overlay'
import { FragmentOverlay } from './fragment-overlay'
import { ParamsDialog } from './params-dialog'
import { RefOverlay } from './ref-overlay'
import { SOURCE_BANNER_HEIGHT, SourceBanner } from './source-banner'
import { Button } from './ui/button'

export function PromptPanel(): React.JSX.Element {
  const request = useGenerationStore((s) => s.request)
  const patch = useGenerationStore((s) => s.patchRequest)
  const queue = useGenerationStore((s) => s.queue)
  const batchCount = useGenerationStore((s) => s.batchCount)
  const setBatchCount = useGenerationStore((s) => s.setBatchCount)
  const generate = useGenerationStore((s) => s.generate)
  const cancelAll = useGenerationStore((s) => s.cancelAll)
  const charOverlayOpen = useCharactersStore((s) => s.overlayOpen)
  const toggleCharOverlay = useCharactersStore((s) => s.toggleOverlay)
  const charItems = useCharactersStore((s) => s.items)
  const fragOverlayOpen = useFragmentsStore((s) => s.overlayOpen)
  const setFragOverlayOpen = useFragmentsStore((s) => s.setOverlayOpen)
  const vibeOverlayOpen = useVibesStore((s) => s.overlayOpen)
  const setVibeOverlayOpen = useVibesStore((s) => s.setOverlayOpen)
  const enabledVibes = useVibesStore((s) => s.items.filter((v) => v.enabled).length)
  const crefOverlayOpen = useCharRefsStore((s) => s.overlayOpen)
  const setCrefOpen = useCharRefsStore((s) => s.setOverlayOpen)
  const enabledCrefs = useCharRefsStore((s) => s.items.filter((c) => c.enabled).length)
  const source = useGenerationStore((s) => s.source)
  const [paramsOpen, setParamsOpen] = useState(false)

  // 씬 모드: 생성은 예약된 씬들을 예약 수만큼 큐에 넣는다. 예약 0이면 생성 버튼 비활성.
  const centerMode = useLayoutStore((s) => s.centerMode)
  const sceneReserved = useScenesStore((s) => totalReserved(s.scenes))
  const generateReserved = useScenesStore((s) => s.generateReserved)
  const isScene = centerMode === 'scene'
  // 프롬프트/네거티브 개별 접기 — 하나를 접으면 다른 하나가 넓어짐
  const [posCollapsed, setPosCollapsed] = useState(false)
  const [negCollapsed, setNegCollapsed] = useState(false)

  const subscriptionTier = useGenerationStore((s) => s.subscriptionTier)
  const queueCount =
    queue?.items.filter((i) => i.state === 'pending' || i.state === 'generating').length ?? 0
  const generating = queueCount > 0
  const activeChars = charItems.filter((c) => c.enabled && c.prompt.trim()).length

  // 토큰 예산: 포지티브(기본+캐릭터 합산)와 네거티브(UC+캐릭터 네거 합산)가 각각 512 공유
  // — 공홈 실측으로 확인. 카운트는 입력 원문 기준 (프리셋/퀄리티 태그 미포함)
  const [tokenTotals, setTokenTotals] = useState<{ pos: number | null; neg: number | null }>({
    pos: null,
    neg: null
  })
  const enabledChars = useMemo(
    () => charItems.filter((c) => c.enabled && c.prompt.trim()),
    [charItems]
  )
  useEffect(() => {
    const posTexts = [request.prompt, ...enabledChars.map((c) => c.prompt)].filter((t) => t.trim())
    const negTexts = [request.negativePrompt, ...enabledChars.map((c) => c.negativePrompt)].filter(
      (t) => t.trim()
    )
    if (posTexts.length === 0 && negTexts.length === 0) {
      const timer = setTimeout(() => setTokenTotals({ pos: null, neg: null }))
      return () => clearTimeout(timer)
    }
    const timer = setTimeout(() => {
      void window.nais
        .invoke('tokens:count', { texts: [...posTexts, ...negTexts] })
        .then(({ counts }) => {
          // 공홈은 캡션별 EOS를 각각 포함해 그대로 합산한다 (빈 칸 = 1토큰인 이유)
          const sum = (arr: number[]): number | null =>
            arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0)
          setTokenTotals({
            pos: sum(counts.slice(0, posTexts.length)),
            neg: sum(counts.slice(posTexts.length))
          })
        })
    }, 250)
    return () => clearTimeout(timer)
  }, [request.prompt, request.negativePrompt, enabledChars])

  const anlas = useMemo(
    () =>
      estimateAnlas({
        width: request.width,
        height: request.height,
        steps: request.steps,
        charRefCount: enabledCrefs,
        isOpus: subscriptionTier === 'opus',
        batchCount,
        unencodedVibes: 0 // 캐시 상태는 오버레이에서 확인 — 배지로만 안내
      }),
    [request.width, request.height, request.steps, subscriptionTier, batchCount, enabledCrefs]
  )

  // 오버레이는 하나만 열림 — 서로 배타
  const only = (target: 'char' | 'frag' | 'vibe' | 'cref'): void => {
    const map = {
      char: charOverlayOpen,
      frag: fragOverlayOpen,
      vibe: vibeOverlayOpen,
      cref: crefOverlayOpen
    }
    const willOpen = !map[target]
    if (charOverlayOpen) toggleCharOverlay()
    setFragOverlayOpen(false)
    setVibeOverlayOpen(false)
    setCrefOpen(false)
    if (!willOpen) return
    if (target === 'char') toggleCharOverlay()
    else if (target === 'frag') setFragOverlayOpen(true)
    else if (target === 'vibe') setVibeOverlayOpen(true)
    else setCrefOpen(true)
  }

  return (
    <aside className="relative flex h-full w-full flex-col gap-3 rounded-xl border border-line bg-surface p-3">
      {/* 상단 여백을 창 드래그 영역으로 (프롬프트 영역 위) */}
      <div className="drag absolute inset-x-0 top-0 h-3" />
      {/* 오버레이는 프롬프트 영역만 덮는다 — 하단 버튼들은 항상 접근 가능 (NAIS2 2.0.7 교훈)
          셸 하나가 열림/닫힘만 애니메이션하고 내용은 즉시 전환 — 오버레이 간 전환 깜빡임 방지 */}
      <div className="relative flex min-h-0 flex-1 flex-col gap-2">
        <AnimatePresence>
          {(charOverlayOpen || fragOverlayOpen || vibeOverlayOpen || crefOverlayOpen) && (
            <motion.div
              key="overlay-shell"
              className="absolute -inset-1 z-10 rounded-lg bg-surface p-1"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            >
              {charOverlayOpen ? (
                <CharacterOverlay />
              ) : fragOverlayOpen ? (
                <FragmentOverlay />
              ) : vibeOverlayOpen ? (
                // key로 vibe↔charref 전환 시 리마운트 → 카드 등장 애니메이션 방지 (캐릭터/조각과 동일하게 빠릿)
                <RefOverlay key="vibe" kind="vibe" />
              ) : (
                <RefOverlay key="charref" kind="charref" />
              )}
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {source && (
            <motion.div
              key="source-banner"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: SOURCE_BANNER_HEIGHT, opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="shrink-0 overflow-hidden"
            >
              <SourceBanner />
            </motion.div>
          )}
        </AnimatePresence>
        {/* 프롬프트 프리셋 — 포지티브 프롬프트 위 */}
        <PromptPresetBar />
        <div
          className={
            'flex min-h-0 flex-col gap-1 ' +
            (posCollapsed ? 'flex-none' : negCollapsed ? 'flex-1' : 'flex-[3]')
          }
        >
          <CollapseHeader
            label="프롬프트"
            collapsed={posCollapsed}
            onToggle={() => setPosCollapsed((v) => !v)}
          />
          {!posCollapsed && (
            <PromptEditor
              className="min-h-0 flex-1"
              value={request.prompt}
              tokensOverride={tokenTotals.pos}
              placeholder="1girl, ...  (태그 자동완성 · <조각>)"
              onValueChange={(v) => patch({ prompt: v })}
            />
          )}
        </div>
        <div
          className={
            'flex min-h-0 flex-col gap-1 ' +
            (negCollapsed ? 'flex-none' : posCollapsed ? 'flex-1' : 'flex-[1.6]')
          }
        >
          <CollapseHeader
            label="네거티브"
            collapsed={negCollapsed}
            onToggle={() => setNegCollapsed((v) => !v)}
          />
          {!negCollapsed && (
            <PromptEditor
              negative
              className="min-h-0 flex-1"
              value={request.negativePrompt}
              tokensOverride={tokenTotals.neg}
              placeholder="UC 프리셋 뒤에 이어 붙습니다"
              onValueChange={(v) => patch({ negativePrompt: v })}
            />
          )}
        </div>
      </div>

      {/* 도구 행: 캐릭터 / 조각 / 바이브 / 레퍼런스 */}
      <div className="grid grid-cols-4 gap-1.5">
        <ToolButton
          active={charOverlayOpen}
          icon={<UsersRound size={14} />}
          label="캐릭터"
          badge={activeChars}
          onClick={() => only('char')}
        />
        <ToolButton
          active={fragOverlayOpen}
          icon={<Puzzle size={14} />}
          label="조각"
          badge={0}
          onClick={() => only('frag')}
        />
        <ToolButton
          active={vibeOverlayOpen}
          icon={<Layers size={14} />}
          label="바이브"
          badge={enabledVibes}
          onClick={() => only('vibe')}
        />
        <ToolButton
          active={crefOverlayOpen}
          icon={<ImageUp size={14} />}
          label="레퍼런스"
          badge={enabledCrefs}
          onClick={() => only('cref')}
        />
      </div>

      {/* 생성 행: 파라미터 / 배치 / 생성 */}
      <div className="flex items-center gap-2">
        <Button
          size="icon"
          variant="ghost"
          className="h-10 w-9 shrink-0"
          title="생성 파라미터"
          onClick={() => setParamsOpen(true)}
        >
          <SlidersHorizontal size={16} />
        </Button>
        <div className="flex h-10 items-center rounded-md border border-line bg-paper">
          <Button
            size="icon"
            variant="ghost"
            className="h-full w-7 rounded-r-none"
            onClick={() => setBatchCount(batchCount - 1)}
          >
            <Minus size={13} />
          </Button>
          <span className="w-8 text-center font-mono text-[13px]">{batchCount}</span>
          <Button
            size="icon"
            variant="ghost"
            className="h-full w-7 rounded-l-none"
            onClick={() => setBatchCount(batchCount + 1)}
          >
            <Plus size={13} />
          </Button>
        </div>
        {generating ? (
          <Button variant="danger" size="lg" className="flex-1" onClick={() => void cancelAll()}>
            <Square size={14} /> 취소 ({queueCount})
          </Button>
        ) : isScene ? (
          <Button
            variant="accent"
            size="lg"
            className="flex-1 gap-2"
            disabled={sceneReserved === 0}
            title={
              sceneReserved === 0
                ? '씬에 예약(+)을 걸어야 생성할 수 있습니다'
                : `예약된 ${sceneReserved}장 생성`
            }
            onClick={() => void generateReserved()}
          >
            씬 생성
            {sceneReserved > 0 && (
              // 한글 '장'이 mono 폴백(Windows Consolas)에서 깨져 보여 기본 폰트(Pretendard) 사용
              <span className="text-[12px] opacity-75">{sceneReserved}장</span>
            )}
          </Button>
        ) : (
          <Button
            variant="accent"
            size="lg"
            className="flex-1 gap-2"
            title={
              anlas.free
                ? '무료 생성 (Opus · 1024² 이하 · 28스텝 이하)'
                : `장당 ${anlas.perImage} Anlas × ${batchCount}`
            }
            onClick={() => void generate()}
          >
            생성
          </Button>
        )}
      </div>

      <ParamsDialog open={paramsOpen} onOpenChange={setParamsOpen} />
    </aside>
  )
}

/** 프롬프트/네거티브 라벨 + 개별 접기 토글(^) */
function CollapseHeader({
  label,
  collapsed,
  onToggle
}: {
  label: string
  collapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onToggle}
      className="flex shrink-0 items-center justify-between text-[12px] font-medium text-muted transition-colors hover:text-ink"
      title={collapsed ? `${label} 펼치기` : `${label} 접기`}
    >
      <span>{label}</span>
      {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
    </button>
  )
}

function ToolButton({
  active,
  icon,
  label,
  badge,
  onClick
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  badge: number
  onClick: () => void
}): React.JSX.Element {
  return (
    <div className="relative">
      <Button
        variant={active ? 'default' : 'ghost'}
        className="h-8 w-full min-w-0 gap-1 px-1.5 text-[12px]"
        onClick={onClick}
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
      </Button>
      {badge > 0 && (
        // 우측 상단에 겹치는 알림 배지 (붉은 원)
        <span className="pointer-events-none absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 font-mono text-[10px] font-medium text-white shadow">
          {badge}
        </span>
      )}
    </div>
  )
}
