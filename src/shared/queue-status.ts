import type { QueueItem } from './types'

/** 큐에 남겨 둘 종료(done/failed/cancelled) 항목 수 — 렌더러 diff·완료 표시에 필요한 만큼만 */
export const MAX_FINISHED_QUEUE_ITEMS = 50

/**
 * 종료 순서 기록. 큐 items가 세션 내내 쌓이면 방송 페이로드와 순회 비용이 계속 커지므로
 * 오래 전에 끝난 항목부터 지운다. 큐 순서가 아니라 "끝난 순서" 기준이라
 * 방금 끝난 항목은 그 방송에서 반드시 살아남는다 (렌더러가 완료를 놓치지 않게).
 */
export class FinishedQueueLog {
  private ids: string[] = []

  constructor(private readonly keep = MAX_FINISHED_QUEUE_ITEMS) {}

  /** 방금 종료된 항목을 기록하고, 한도를 넘어 이제 지워야 할 id들을 반환 */
  record(id: string): string[] {
    this.ids.push(id)
    const overflow = this.ids.length - this.keep
    return overflow > 0 ? this.ids.splice(0, overflow) : []
  }
}

/**
 * 방송용 스냅샷 — i2i/인페인트 원본(source)은 생성하는 쪽에서만 쓰므로 뺀다.
 * 항목마다 수 MB base64라 상태 변경마다 IPC로 복제하면 배치가 길수록 부담이 커진다.
 */
export function queueItemSnapshot(item: QueueItem): QueueItem {
  if (!item.request.source) return { ...item }
  const request = { ...item.request }
  delete request.source
  return { ...item, request }
}
