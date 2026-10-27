import * as SwitchPrimitive from '@radix-ui/react-switch'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils'

export function Switch({
  className,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root>): React.JSX.Element {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-line bg-surface-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-3.5 translate-x-[1.5px] rounded-full bg-paper shadow-sm transition-transform data-[state=checked]:translate-x-[15.5px]" />
    </SwitchPrimitive.Root>
  )
}
