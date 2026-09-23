import { settings } from '../settings'

const qs = new URLSearchParams(location.search)

/** dev switches: `?mouseTouch=1` treats mouse pointers as touch; `?touchdebug=1` draws touch debug info */
export const DEV = {
  mouseTouch: qs.get('mouseTouch') === '1',
  touchDebug: qs.get('touchdebug') === '1',
}

const mm = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches

/** best-effort touch-first device detection (phones, tablets incl. iPadOS reporting as Mac) */
export function isTouchDevice(): boolean {
  const points = navigator.maxTouchPoints || 0
  const coarseOnly = mm('(pointer: coarse)') && !mm('(any-pointer: fine)')
  const iPadOS = /Macintosh/.test(navigator.userAgent) && points > 1
  const mobileUA = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent) && points > 0
  return coarseOnly || iPadOS || mobileUA
}

/** is the touch UI active right now (URL override `?mobile=1|0`, setting, or auto-detect) */
export function mobileActive(): boolean {
  const p = qs.get('mobile')
  if (p === '1') return true
  if (p === '0') return false
  if (settings.mobileMode === 'on') return true
  if (settings.mobileMode === 'off') return false
  return isTouchDevice()
}

export function applyDeviceClasses() {
  document.body.classList.toggle('mobile', mobileActive())
}

/** call once at boot, before the first screen */
export function initDevice() {
  applyDeviceClasses()
  const safe = qs.get('safe')
  if (safe) {
    const [l, r, b, t] = safe.split(',').map(v => Number(v) || 0)
    const st = document.documentElement.style
    st.setProperty('--sal', l + 'px')
    st.setProperty('--sar', (r ?? 0) + 'px')
    st.setProperty('--sab', (b ?? 0) + 'px')
    st.setProperty('--sat', (t ?? 0) + 'px')
  }
  const re = () => { if (!document.body.classList.contains('in-game')) applyDeviceClasses() }
  for (const q of ['(pointer: coarse)', '(any-pointer: fine)']) {
    try { matchMedia(q).addEventListener('change', re) } catch { /* old Safari */ }
  }
}

export function isPortrait() {
  return mm('(orientation: portrait)')
}

export function canFullscreen() {
  return !!document.documentElement.requestFullscreen && !!document.fullscreenEnabled
}

export function lockLandscape() {
  if (!mobileActive()) return
  try { (screen.orientation as any)?.lock?.('landscape')?.catch?.(() => {}) } catch { /* unsupported */ }
}

export function unlockOrientation() {
  try { screen.orientation?.unlock?.() } catch { /* unsupported */ }
}

/** must be called from a user-gesture handler (click / pointerup) */
export function requestFullscreen() {
  if (!mobileActive() || !canFullscreen() || document.fullscreenElement) return
  document.documentElement.requestFullscreen({ navigationUI: 'hide' } as FullscreenOptions)
    .then(() => { if (document.body.classList.contains('in-game')) lockLandscape() })
    .catch(() => {})
}

/** touch HUD scale factor relative to an 844x390 landscape phone */
export function uiScale() {
  const base = Math.min(1.3, Math.max(0.8, Math.min(innerHeight / 390, innerWidth / 844)))
  // the right cluster is 361·s tall (anchor 62 + cancel zone top 299): never let the user's multiplier push it off screen
  const ins = safeInsets()
  const fit = (innerHeight - ins.b - ins.t - 8) / 361
  return Math.max(0.7, Math.min(1.3, fit, base * (settings.uiScale || 1)))
}

let probe: HTMLDivElement | null = null
/** resolved safe-area insets in px (left, right, bottom, top), including the minimum paddings used by the touch HUD */
export function safeInsets(): { l: number; r: number; b: number; t: number } {
  if (!probe) {
    probe = document.createElement('div')
    probe.className = 'safe-probe'
    document.body.appendChild(probe)
  }
  const cs = getComputedStyle(probe)
  return {
    l: parseFloat(cs.paddingLeft) || 0,
    r: parseFloat(cs.paddingRight) || 0,
    b: parseFloat(cs.paddingBottom) || 0,
    t: parseFloat(cs.paddingTop) || 0,
  }
}
