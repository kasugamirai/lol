import { PROFILE_SUFFIX } from './config'

export interface Settings {
  castMode: 'quick' | 'indicator'
  shadows: boolean
  quality: 0 | 1
  volume: number
  edgePan: boolean
  showFps: boolean
  lastChamp: string
  spells: [string, string]
  practiceMap: 'rift' | 'aram'
  practiceSize: number
  botDiff: number
  camLock: boolean
  /** touch UI: auto-detect, force on, force off */
  mobileMode: 'auto' | 'on' | 'off'
  /** touch joystick: base appears under the thumb (dynamic) or stays put (fixed) */
  joyMode: 'dynamic' | 'fixed'
  /** touch attack button champion priority */
  atkPri: 'lowhp' | 'near'
  /** move the camera ahead while aiming a long-range skill */
  aimCam: boolean
  /** touch HUD scale multiplier (0.8 - 1.3) */
  uiScale: number
  /** camera distance in touch mode (0.70 - 1.00) */
  touchZoom: number
  /** one-time low-quality default applied on touch hardware */
  mobilePerfInit: boolean
}

const KEY = 'nexusrift.settings' + PROFILE_SUFFIX
const defaults: Settings = {
  castMode: 'quick', shadows: true, quality: 1, volume: 0.5, edgePan: true, showFps: false,
  lastChamp: 'blaze', spells: ['flash', 'heal'], practiceMap: 'rift', practiceSize: 5, botDiff: 1, camLock: true,
  mobileMode: 'auto', joyMode: 'dynamic', atkPri: 'lowhp', aimCam: true, uiScale: 1, touchZoom: 0.82, mobilePerfInit: false,
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...defaults, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ...defaults }
}

export const settings: Settings = load()

export function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch { /* ignore */ }
}
