import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { GripVertical } from 'lucide-react'
import type { CSSProperties } from 'react'
import { cn } from '../lib/utils'

/** 드롭다운 목록용 세로 드래그 정렬 컨테이너 — onReorder에 새 id 순서 전달 */
export function SortableList({
  ids,
  onReorder,
  children
}: {
  ids: number[]
  onReorder: (ids: number[]) => void
  children: React.ReactNode
}): React.JSX.Element {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const onDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = ids.indexOf(Number(active.id))
    const to = ids.indexOf(Number(over.id))
    if (from < 0 || to < 0) return
    onReorder(arrayMove(ids, from, to))
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  )
}

/** 드래그 가능한 행 — 그립 핸들로만 드래그 (행 내 버튼 클릭 방해 없음) */
export function SortableRow({
  id,
  className,
  children
}: {
  id: number
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const sortable = useSortable({ id })
  const style: CSSProperties = {
    transform: sortable.transform
      ? `translate3d(${sortable.transform.x}px, ${sortable.transform.y}px, 0)`
      : undefined,
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.6 : undefined,
    zIndex: sortable.isDragging ? 10 : undefined,
    position: 'relative'
  }
  return (
    <div ref={sortable.setNodeRef} style={style} className={cn('flex items-center', className)}>
      <button
        {...sortable.attributes}
        {...sortable.listeners}
        className="shrink-0 cursor-grab touch-none rounded p-0.5 text-faint/60 hover:text-muted active:cursor-grabbing"
        tabIndex={-1}
      >
        <GripVertical size={12} />
      </button>
      {children}
    </div>
  )
}
