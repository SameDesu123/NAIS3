import * as SwitchPrimitive from '@radix-ui/react-switch'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils'

// 크기는 모두 px로 — 손잡이 이동 거리가 px라, 크기만 rem이면 브라우저 기본 글꼴 크기에 따라 손잡이가 틀을 벗어난다
export function Switch({
  className,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root>): React.JSX.Element {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full border border-line bg-surface-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-[14px] translate-x-[1.5px] rounded-full bg-paper shadow-sm transition-transform data-[state=checked]:translate-x-[15.5px]" />
    </SwitchPrimitive.Root>
  )
}
