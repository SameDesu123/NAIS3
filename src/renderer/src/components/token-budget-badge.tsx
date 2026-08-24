import { cn } from '../lib/utils'

export function TokenBudgetBadge({
  tokens,
  limit,
  className
}: {
  tokens: number | null
  limit: number
  className?: string
}): React.JSX.Element | null {
  if (tokens === null) return null
  const over = tokens > limit

  return (
    <span
      className={cn(
        'rounded bg-paper px-1.5 py-0.5 font-mono text-[10.5px]',
        over ? 'text-danger' : 'text-faint',
        className
      )}
      title={
        over
          ? `한도 초과 — 전체 ${tokens}/${limit} 토큰. 초과분은 잘려서 반영되지 않습니다`
          : `전체 프롬프트 ${tokens}/${limit} 토큰`
      }
    >
      {tokens}/{limit}
    </span>
  )
}
