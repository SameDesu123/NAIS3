import { ArrowLeft, Download, type LucideIcon } from 'lucide-react'
import { useEffect } from 'react'
import { useT } from '../lib/i18n'
import { toast } from '../stores/toast-store'
import { Button } from './ui/button'
import { Switch } from './ui/switch'

/**
 * 옆 페이지로 여는 편집 툴의 공통 틀 — 왼쪽은 점 격자 작업대, 오른쪽은 디렉터 툴 패널과 같은 폭·헤더의 옵션 패널.
 * 새 로컬 편집 툴은 LocalEditorProps를 받는 컴포넌트를 만들고 이 틀에 작업대·옵션·실행 버튼만 채우면 된다.
 */

/** 디렉터 로컬 편집 툴(옆 페이지)이 공통으로 받는 값 */
export interface LocalEditorProps {
  /** 페이지 넘김이 끝났는지 — 끝나기 전엔 원본 해독 같은 무거운 작업을 미룬다 */
  ready: boolean
  /** 열 때의 이미지 — 편집 중 스택이 바뀌어도 고정 */
  imageBase64: string
  width: number
  height: number
  onConfirm: (resultBase64: string) => void
  onCancel: () => void
}

export function ToolPage({
  icon: Icon,
  title,
  description,
  stage,
  footer,
  onBack,
  children
}: {
  icon: LucideIcon
  title: string
  description?: string
  /** 왼쪽 작업대 — 보통 ToolPageStage */
  stage: React.ReactNode
  /** 옵션 패널 하단 고정 영역 — 보통 ToolPageActions */
  footer?: React.ReactNode
  onBack: () => void
  /** 옵션 패널 본문 — 보통 ToolPageSection들 */
  children?: React.ReactNode
}): React.JSX.Element {
  const t = useT()

  // Esc로 돌아가기. 다른 곳이 먼저 처리했거나 위에 대화상자(설정 등)가 떠 있으면 그쪽 몫
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[role="dialog"]')) return
      onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  return (
    <div className="flex h-full min-h-0 gap-3">
      {stage}

      <div className="flex w-[320px] shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line pl-1 pr-3">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t('ui.back')}
            title={t('ui.back')}
            onClick={onBack}
          >
            <ArrowLeft size={14} />
          </Button>
          <Icon size={14} className="text-muted" />
          {/* 페이지를 열면 포커스가 여기로 온다 (SidePageHost) — 화면 낭독기가 어디로 왔는지 읽는다 */}
          <h2 tabIndex={-1} data-page-focus className="ml-1 text-[13px] font-medium outline-none">
            {title}
          </h2>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3 no-scrollbar">
          {description && (
            <p className="px-0.5 text-[12px] leading-relaxed text-muted">{description}</p>
          )}
          {children}
        </div>

        {footer && <div className="grid shrink-0 gap-1.5 border-t border-line p-3">{footer}</div>}
      </div>
    </div>
  )
}

/**
 * 점 격자 작업대 — 캐릭터 배치 편집기와 같은 모양.
 * children은 이미지 비율을 지키며 작업대에 꽉 맞춘 틀 안에 놓인다 (틀이 relative라 absolute로 겹쳐 쌓으면 된다).
 */
export function ToolPageStage({
  width,
  height,
  children
}: {
  width: number
  height: number
  children: React.ReactNode
}): React.JSX.Element {
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 rounded-xl border border-line bg-surface p-6"
      style={{
        backgroundImage: 'radial-gradient(var(--color-line) 1px, transparent 1.5px)',
        backgroundSize: '18px 18px',
        backgroundPosition: 'center'
      }}
    >
      <div
        className="flex min-h-0 min-w-0 flex-1 items-center justify-center"
        style={{ containerType: 'size' }}
      >
        <div
          className="relative shrink-0 overflow-hidden rounded-md border border-line bg-paper shadow-xl shadow-black/25"
          style={{ width: `min(100%, calc(100cqh * ${w / h}))`, aspectRatio: `${w} / ${h}` }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}

/** 옵션 패널 한 묶음 — 아이콘·제목, 오른쪽에 현재 값 */
export function ToolPageSection({
  icon: Icon,
  label,
  value,
  children
}: {
  icon: LucideIcon
  label: string
  value?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-0.5">
      <div className="mb-1 flex items-center gap-1.5 px-2.5 text-[11px] font-medium text-muted">
        <Icon size={12} />
        <span className="flex-1">{label}</span>
        {value != null && <span className="font-mono text-[10.5px] text-muted">{value}</span>}
      </div>
      {children}
    </section>
  )
}

/** 섹션 안 슬라이더 자리 — 섹션 제목과 같은 들여쓰기 */
export function ToolPageSliderRow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="px-2.5 py-2">{children}</div>
}

/** 켜고 끄는 한 줄 — 줄 전체가 눌린다 */
export function ToolPageToggle({
  label,
  title,
  checked,
  onCheckedChange
}: {
  label: string
  title?: string
  checked: boolean
  onCheckedChange: (on: boolean) => void
}): React.JSX.Element {
  return (
    <label
      className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[12.5px] transition-colors hover:bg-surface-2"
      title={title}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  )
}

/** 읽기 전용 한 줄 — 왼쪽 이름, 오른쪽 값 */
export function ToolPageInfo({
  label,
  value
}: {
  label: string
  value: string
}): React.JSX.Element {
  return (
    <div className="flex h-8 items-center gap-2 px-2.5 text-[12.5px]">
      <span className="min-w-0 flex-1 truncate text-muted">{label}</span>
      <span className="shrink-0 font-mono text-[10.5px] text-muted">{value}</span>
    </div>
  )
}

/**
 * 적용 / 파일로 저장 / 취소. exportResult는 결과 base64 PNG를 만들고, 아직 준비 전이면 null.
 * 파일로 저장은 스택·히스토리를 거치지 않고 페이지를 연 채로 바로 저장한다.
 */
export function ToolPageActions({
  disabled,
  exportResult,
  fileName,
  downloadTitle,
  onApply,
  onCancel
}: {
  disabled?: boolean
  exportResult: () => string | null
  fileName: string
  downloadTitle?: string
  onApply: (resultBase64: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <>
      <Button
        variant="accent"
        size="lg"
        className="w-full"
        disabled={disabled}
        onClick={() => {
          const base64 = exportResult()
          if (base64) onApply(base64)
        }}
      >
        {t('ui.apply')}
      </Button>
      <div className="grid grid-cols-2 gap-1.5">
        <Button
          variant="ghost"
          className="gap-1"
          disabled={disabled}
          title={downloadTitle}
          onClick={() => {
            const base64 = exportResult()
            if (!base64) return
            void window.nais
              .invoke('images:saveBase64As', { base64, defaultName: fileName })
              .then(({ saved }) => saved && toast(t('ui.saved'), 'success'))
          }}
        >
          <Download size={13} /> {t('ui.download')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('ui.cancel')}
        </Button>
      </div>
    </>
  )
}
