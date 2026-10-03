import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { zoomAroundPoint, type Point } from './mask-geometry'

const MIN_ZOOM = 1
const MAX_ZOOM = 16

interface ViewTransform {
  key: string
  zoom: number
  pan: Point
}

export function useImageViewport(
  width: number,
  height: number,
  padding = 16
): {
  viewportRef: React.RefObject<HTMLDivElement | null>
  frameStyle: CSSProperties
  zoomLabel: string
  zoomIn: () => void
  zoomOut: () => void
  resetView: () => void
  beginPan: (event: ReactPointerEvent) => boolean
  movePan: (event: ReactPointerEvent) => boolean
  endPan: (event: ReactPointerEvent) => void
  panning: boolean
} {
  const imageKey = `${width}x${height}`
  const viewportRef = useRef<HTMLDivElement>(null)
  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 })
  const [storedTransform, setStoredTransform] = useState<ViewTransform>({
    key: imageKey,
    zoom: 1,
    pan: { x: 0, y: 0 }
  })
  const transform =
    storedTransform.key === imageKey
      ? storedTransform
      : { key: imageKey, zoom: 1, pan: { x: 0, y: 0 } }
  const [panning, setPanning] = useState(false)
  const panStart = useRef<{ pointer: Point; pan: Point; pointerId: number } | null>(null)
  const spaceHeld = useRef(false)

  useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const update = (): void =>
      setViewportSize({ width: element.clientWidth || 1, height: element.clientHeight || 1 })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (event.code !== 'Space' || target?.closest('input, textarea, [contenteditable="true"]'))
        return
      spaceHeld.current = true
      // Keep native keyboard activation while tracking Space for the next drag.
      if (!target?.closest('button, [role="slider"]')) event.preventDefault()
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space') spaceHeld.current = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  const fitScale = Math.min(
    1,
    Math.max(0.01, (viewportSize.width - padding * 2) / Math.max(1, width)),
    Math.max(0.01, (viewportSize.height - padding * 2) / Math.max(1, height))
  )
  const frameWidth = Math.max(1, Math.round(width * fitScale))
  const frameHeight = Math.max(1, Math.round(height * fitScale))

  const setZoomCentered = useCallback(
    (next: number): void => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
      setStoredTransform({
        key: imageKey,
        zoom,
        pan: zoom === 1 ? { x: 0, y: 0 } : transform.pan
      })
    },
    [imageKey, transform.pan]
  )

  const resetView = useCallback((): void => {
    setStoredTransform({ key: imageKey, zoom: 1, pan: { x: 0, y: 0 } })
  }, [imageKey])

  // React's wheel listener is passive; a native listener must cancel browser zoom/scroll.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = viewport.getBoundingClientRect()
      const pointer = {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2
      }
      setStoredTransform((current) => {
        const previous =
          current.key === imageKey ? current : { key: imageKey, zoom: 1, pan: { x: 0, y: 0 } }
        const next = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, previous.zoom * Math.exp(-event.deltaY * 0.0015))
        )
        return {
          key: imageKey,
          zoom: next,
          pan: zoomAroundPoint(previous.pan, previous.zoom, next, pointer)
        }
      })
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [imageKey])

  function beginPan(event: ReactPointerEvent): boolean {
    if (event.button !== 1 && !(event.button === 0 && spaceHeld.current)) return false
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    panStart.current = {
      pointer: { x: event.clientX, y: event.clientY },
      pan: transform.pan,
      pointerId: event.pointerId
    }
    setPanning(true)
    return true
  }

  function movePan(event: ReactPointerEvent): boolean {
    const start = panStart.current
    if (!start || start.pointerId !== event.pointerId) return false
    setStoredTransform({
      key: imageKey,
      zoom: transform.zoom,
      pan: {
        x: start.pan.x + event.clientX - start.pointer.x,
        y: start.pan.y + event.clientY - start.pointer.y
      }
    })
    return true
  }

  function endPan(event: ReactPointerEvent): void {
    if (panStart.current?.pointerId !== event.pointerId) return
    panStart.current = null
    setPanning(false)
  }

  return {
    viewportRef,
    frameStyle: {
      width: frameWidth,
      height: frameHeight,
      left: `calc(50% - ${frameWidth / 2}px)`,
      top: `calc(50% - ${frameHeight / 2}px)`,
      transform: `translate3d(${transform.pan.x}px, ${transform.pan.y}px, 0) scale(${transform.zoom})`,
      transformOrigin: 'center center'
    },
    zoomLabel: `${Math.round(transform.zoom * 100)}%`,
    zoomIn: () => setZoomCentered(transform.zoom * 1.25),
    zoomOut: () => setZoomCentered(transform.zoom / 1.25),
    resetView,
    beginPan,
    movePan,
    endPan,
    panning
  }
}
