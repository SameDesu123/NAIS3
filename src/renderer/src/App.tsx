import { AnimatePresence, motion } from 'motion/react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { HistoryPanel } from './components/history-panel'
import { LoadingScreen } from './components/loading-screen'
import { Toaster } from './components/toaster'
import { PreviewPane } from './components/preview-pane'
import { DirectorMode } from './components/director-mode'
import { InpaintHost } from './components/inpaint-host'
import { LibraryMode } from './components/library-mode'
import { ArtistTagsDialog } from './components/artist-tags-dialog'
import { MetadataDialog } from './components/metadata-dialog'
import { SidePageHost } from './components/side-page-host'
import { PromptPanel } from './components/prompt-panel'
import { SceneMode } from './components/scene-mode'
import { Titlebar } from './components/titlebar'
import { SettingsDialog } from './components/token-dialog'
import { TextPromptHost } from './components/text-prompt-host'
import { FragmentEditorDialog } from './components/fragment-editor-dialog'
import { WebSearchMode } from './components/web-search-mode'
import { TooltipProvider } from './components/ui/tooltip'
import { useCharactersStore } from './stores/characters-store'
import { useDirectorStore } from './stores/director-store'
import { useFragmentsStore } from './stores/fragments-store'
import { useCharRefsStore, useVibesStore } from './stores/refs-store'
import { bindGenerationEvents, useGenerationStore } from './stores/generation-store'
import { bindSceneEvents } from './stores/scenes-store'
import { bindShortcuts, useShortcutsStore } from './stores/shortcuts-store'
import { bindUpdateEvents } from './stores/update-store'
import { bindNavMouse } from './lib/nav-history'
import { useLanguageStore } from './lib/i18n'
import { cn } from './lib/utils'
import { useLayoutStore } from './stores/layout-store'
import { useThemeStore } from './stores/theme-store'

// 좌우 패널 접기/펴기 — 패널은 제자리에서 뒤로 물러나며 흐려지고, 메인 영역이 넓어지며 그 위를 덮는다.
// 바깥 칸은 차지하는 폭만 줄이고, 안의 패널은 바깥쪽 벽에 붙은 채 원래 폭 그대로 메인 아래로 들어간다.
// 칸 사이 간격(SidePageHost의 gap-3)도 음수 여백으로 같이 접어야 마지막에 12px 툭 끊기지 않는다
const PANEL_GAP = 12
// 페이지 넘김(SidePageHost)과 같은 속도
const PANEL_EASE = { duration: 0.32, ease: [0.22, 1, 0.36, 1] } as const
// scale이 아니라 transform 문자열로 — Motion이 브라우저(WAAPI) 애니메이션으로 컴포지터에서 돌린다.
// scale로 주면 매 프레임 메인 스레드가 값을 쓰고 패널 전체를 다시 그려, 폭 줄이기(레이아웃)와 겹쳐 끊긴다
// 둘이 한꺼번에 움직이면 메인이 처음 닿는 순간 패널이 아직 거의 그대로라 둘이 붙어 보인다.
// 그래서 순서를 엇갈린다 — 접을 땐 패널이 먼저 물러나고 메인이 조금 늦게 덮으며,
// 펼 땐 메인이 먼저 비켜선 뒤 패널이 앞으로 나온다
const PANEL_BACK = {
  opacity: 0.3,
  transform: 'scale(0.94)',
  transition: { ...PANEL_EASE, duration: 0.18 }
}
const PANEL_FRONT = { opacity: 1, transform: 'scale(1)', transition: { ...PANEL_EASE, delay: 0.1 } }
const SLOT_CLOSE = { ...PANEL_EASE, delay: 0.06 }

// 새 설치 첫 실행에만 뜨므로 평소 실행에선 읽지 않는다
const Onboarding = lazy(() =>
  import('./components/onboarding').then(({ Onboarding }) => ({ default: Onboarding }))
)

export default function App(): React.JSX.Element {
  const settingsOpen = useLayoutStore((s) => s.settingsOpen)
  const setSettingsOpen = useLayoutStore((s) => s.setSettingsOpen)
  const centerMode = useLayoutStore((s) => s.centerMode)
  const onboardingOpen = useLayoutStore((s) => s.onboardingOpen)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    // 초기 하이드레이션 — 완료되면 로딩 스플래시 해제
    void (async () => {
      await Promise.allSettled([
        useLanguageStore.getState().hydrate(),
        useThemeStore.getState().hydrate(),
        useLayoutStore.getState().hydrate(),
        useGenerationStore.getState().hydrate(),
        useCharactersStore.getState().load(),
        useFragmentsStore.getState().load(),
        useVibesStore.getState().load(),
        useCharRefsStore.getState().load(),
        useShortcutsStore.getState().hydrate(),
        useDirectorStore.getState().hydrate()
      ])
      // 스플래시가 너무 순식간에 사라지지 않게 최소 표시 시간 확보
      setTimeout(() => setReady(true), 350)
    })()
    const unbindGen = bindGenerationEvents()
    const unbindScene = bindSceneEvents()
    const unbindKeys = bindShortcuts()
    const unbindUpdate = bindUpdateEvents()
    const unbindNav = bindNavMouse() // 마우스 4/5번 버튼 뒤로/앞으로
    // F5 새로고침 (프로덕션에서도)
    const onF5 = (e: KeyboardEvent): void => {
      if (e.key === 'F5') {
        e.preventDefault()
        window.location.reload()
      }
    }
    window.addEventListener('keydown', onF5)
    return () => {
      unbindGen()
      unbindScene()
      unbindKeys()
      unbindUpdate()
      unbindNav()
      window.removeEventListener('keydown', onF5)
    }
  }, [])

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-paper">
        <Titlebar />
        {/* 새 설치 첫 실행 — 작업 영역 자리에 표시 (타이틀바의 창 컨트롤은 그대로).
            스플래시가 걷힐 때 마운트해야 첫 등장 애니메이션이 가려지지 않는다 */}
        {onboardingOpen && ready && (
          <Suspense fallback={null}>
            <Onboarding />
          </Suspense>
        )}
        {/* 온보딩을 마치면 카드가 빠진 뒤 작업 화면이 페이드인 (평소 시작에는 애니메이션 없음) */}
        <motion.div
          className={cn('flex min-h-0 flex-1 flex-col', onboardingOpen && 'hidden')}
          initial={false}
          animate={{ opacity: onboardingOpen ? 0 : 1 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          <SidePageHost>
            <LeftPanel />
            {/* 접히는 패널이 이 아래로 들어간다 — 바탕을 칠하고 위에 쌓아 패널을 가린다 */}
            <main className="relative z-10 flex min-h-0 min-w-0 flex-1 bg-paper">
              {centerMode === 'scene' ? (
                <SceneMode />
              ) : centerMode === 'director' ? (
                <DirectorMode />
              ) : centerMode === 'library' ? (
                <LibraryMode />
              ) : centerMode === 'websearch' ? (
                <WebSearchMode />
              ) : (
                <PreviewPane />
              )}
            </main>
            <RightPanel />
          </SidePageHost>
        </motion.div>
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        <TextPromptHost />
        <FragmentEditorDialog />
        <InpaintHost />
        <MetadataDialog />
        <ArtistTagsDialog />
        <Toaster />
        <AnimatePresence>{!ready && <LoadingScreen key="loading" />}</AnimatePresence>
      </div>
    </TooltipProvider>
  )
}

/**
 * 프롬프트 패널 칸. 열림·폭 구독을 App이 아니라 여기서 해야 접고 펼 때(폭 드래그 중엔 매 이동마다)
 * 메인 영역과 히스토리까지 다시 그려지지 않는다 — 접기 첫 프레임이 그 렌더 때문에 끊겼다
 */
function LeftPanel(): React.JSX.Element {
  const leftOpen = useLayoutStore((s) => s.leftOpen)
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth)
  const [resizing, setResizing] = useState(false)

  // 사이드바 폭 드래그 조절
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    setResizing(true)
    const startX = e.clientX
    const startW = useLayoutStore.getState().sidebarWidth
    const onMove = (ev: MouseEvent): void =>
      useLayoutStore.getState().setSidebarWidth(startW + (ev.clientX - startX))
    const onUp = (): void => {
      setResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <AnimatePresence initial={false}>
      {leftOpen && (
        <motion.div
          key="left"
          className="relative h-full shrink-0"
          variants={{
            front: {
              width: sidebarWidth,
              marginRight: 0,
              // 드래그 중엔 즉시 반영 (애니메이션이 따라오면 답답함)
              transition: resizing ? { duration: 0 } : PANEL_EASE
            },
            back: { width: 0, marginRight: -PANEL_GAP, transition: SLOT_CLOSE }
          }}
          initial="back"
          animate="front"
          exit="back"
        >
          <motion.div
            style={{ width: sidebarWidth }}
            className="absolute inset-y-0 left-0"
            variants={{ front: PANEL_FRONT, back: PANEL_BACK }}
          >
            <PromptPanel />
            {/* 폭 조절 핸들 */}
            <div
              className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-accent/30"
              onMouseDown={startResize}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** 히스토리 패널 칸 — LeftPanel과 같은 이유로 열림 구독을 따로 둔다 */
function RightPanel(): React.JSX.Element {
  const rightOpen = useLayoutStore((s) => s.rightOpen)
  return (
    <AnimatePresence initial={false}>
      {rightOpen && (
        <motion.div
          key="right"
          className="relative h-full shrink-0"
          variants={{
            front: { width: 240, marginLeft: 0, transition: PANEL_EASE },
            back: { width: 0, marginLeft: -PANEL_GAP, transition: SLOT_CLOSE }
          }}
          initial="back"
          animate="front"
          exit="back"
        >
          <motion.div
            className="absolute inset-y-0 right-0 w-[240px]"
            variants={{ front: PANEL_FRONT, back: PANEL_BACK }}
          >
            <HistoryPanel />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
