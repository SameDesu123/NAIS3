import { cn } from '../../lib/utils'

/** 옅은 바탕 묶음 상자 (설정 줄·안내 목록) */
export const PANEL = 'rounded-2xl bg-surface-2/60'

/** 단계 맨 아래 가운데 작은 안내 글 */
export const FOOT_NOTE = 'mt-5 text-center text-[13px] text-muted'

/** 온보딩 드롭다운은 항상 아래로 펼치고, 공간이 모자라면 목록 높이를 줄인다 */
export const DROP_DOWN = {
  side: 'bottom',
  avoidCollisions: false,
  className: 'max-h-[min(300px,var(--radix-select-content-available-height))]'
} as const

/** 선택 카드 공통 테두리 */
export function choiceFrame(selected: boolean): string {
  return cn(
    // 키보드 포커스는 선택 테두리(강조색)와 구별되게 바깥쪽 잉크색 윤곽선으로
    'w-full rounded-2xl border-2 p-1 transition-colors group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-ink',
    selected ? 'border-accent' : 'border-transparent group-hover:border-line'
  )
}
