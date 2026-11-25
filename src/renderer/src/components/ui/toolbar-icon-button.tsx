import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { Button } from './button'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

/**
 * 패널 툴바 아이콘 버튼 — 이름은 시스템 title 대신 NAIS3 툴팁으로 보여준다.
 * 부모 칸을 나눠 쓰도록 폭은 flex-1. pressed를 주면 토글 버튼(aria-pressed + 켜짐 강조).
 * hint를 주면 툴팁은 이름 대신 hint를 보여준다 — 사용법 설명이 이미 이름으로 시작하는 문구라서.
 */
export function ToolbarIconButton({
  icon,
  label,
  hint,
  pressed,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'children' | 'title'> & {
  icon: ReactNode
  label: string
  hint?: string
  pressed?: boolean
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={pressed ? 'accent' : 'default'}
          aria-label={label}
          aria-pressed={pressed}
          className={cn('h-8 min-w-0 flex-1 px-0', className)}
          {...props}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 px-2 py-1 text-[12px]">{hint ?? label}</TooltipContent>
    </Tooltip>
  )
}
