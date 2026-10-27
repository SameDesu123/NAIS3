// 페이지 넘김(SidePageHost)은 브라우저 애니메이션(WAAPI)으로 돈다. 사양상 취소된 애니메이션의
// finished 거부는 처리된 것으로 표시되지만 happy-dom은 그러지 않아, 넘김이 끊길 때마다
// 처리 안 된 거부가 남는다 — 브라우저처럼 처리된 것으로 표시한다
const animate = Element.prototype.animate
Element.prototype.animate = function (...args) {
  const animation = animate.apply(this, args)
  animation.finished.catch(() => undefined)
  return animation
}
