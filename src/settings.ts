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
}

const KEY = 'nexusrift.settings' + PROFILE_SUFFIX
const defaults: Settings = {
  castMode: 'quick', shadows: true, quality: 1, volume: 0.5, edgePan: true, showFps: false,
  lastChamp: 'blaze', spells: ['flash', 'heal'], practiceMap: 'rift', practiceSize: 5, botDiff: 1, camLock: true,
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
