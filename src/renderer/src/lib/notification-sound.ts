/** Shared, asset-free notification chime. Audio failures never prevent visual delivery. */
export function playChime(): void {
  try {
    const ctx = new AudioContext()
    const tone = (freq: number, start: number, dur: number, peak: number): void => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const t0 = ctx.currentTime + start
      gain.gain.setValueAtTime(0, t0)
      gain.gain.linearRampToValueAtTime(peak, t0 + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t0)
      osc.stop(t0 + dur)
    }
    tone(880, 0, 0.35, 0.12)
    tone(1318.5, 0.09, 0.5, 0.1)
    void ctx.resume().catch(() => {})
    setTimeout(() => void ctx.close().catch(() => {}), 900)
  } catch {
    // AudioContext can be unavailable or blocked in browser development mode.
  }
}
