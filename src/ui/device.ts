import { settings } from '../settings'

const qs = new URLSearchParams(location.search)

/** best-effort touch-first device detection (phones, tablets incl. iPadOS reporting as Mac) */
export function isTouchDevice(): boolean {
  const mm = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches
  const points = navigator.maxTouchPoints || 0
  const coarseOnly = mm('(pointer: coarse)') && !mm('(any-pointer: fine)')
  const iPadOS = /Macintosh/.test(navigator.userAgent) && points > 1
  const mobileUA = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent) && points > 0
  return coarseOnly || iPadOS || mobileUA
}

/** is the touch UI active right now (setting, URL override `?mobile=1|0`, or auto-detect) */
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
