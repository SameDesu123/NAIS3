import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { Button } from './button'

/**
 * 아이콘 버튼 — 평소엔 32px 정사각형, 마우스를 올리거나 키보드 포커스를 받으면
 * 오른쪽으로 넓어지며 이름을 보여준다. 이름은 접혀 있어도 접근성 이름으로 쓰인다.
 * pressed를 주면 토글 버튼(aria-pressed + 켜짐 강조)이 된다.
 */
export function ExpandingIconButton({
  icon,
  label,
  pressed,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'children'> & {
  icon: ReactNode
  label: string
  pressed?: boolean
}): React.JSX.Element {
  return (
    <Button
      variant={pressed ? 'accent' : 'default'}
      aria-pressed={pressed}
      className={cn('group h-8 min-w-8 shrink-0 justify-start gap-0 px-[6.5px]', className)}
      {...props}
    >
      {icon}
      <span className="max-w-0 overflow-hidden opacity-0 transition-[max-width,opacity,margin] duration-200 ease-out group-hover:ml-1.5 group-hover:max-w-40 group-hover:opacity-100 group-focus-visible:ml-1.5 group-focus-visible:max-w-40 group-focus-visible:opacity-100 motion-reduce:transition-none">
        {label}
      </span>
    </Button>
  )
}
