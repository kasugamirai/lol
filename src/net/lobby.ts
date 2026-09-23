import { YRoom } from './yroom'
import { APP_VERSION, LOBBY_ROOM } from '../config'
import type { MapId } from '../game/mapdef'
import { randId } from '../util/math'

export interface RoomAd {
  id: string
  name: string
  map: MapId
  teamSize: number
  humans: number
  status: 'lobby' | 'playing' | 'ended'
  ownerName: string
  since: number
}

export type MMMode = 'rift' | 'aram'

export interface MMTicket {
  mode: MMMode
  since: number
  rating: number
}

export interface MMOffer {
  room: string
  mode: MMMode
  players: { pk: string; name: string; team: 0 | 1 }[]
  t: number
  /** formed by "start now": begin as soon as everyone arrives */
  quick?: boolean
}

interface LobbyState {
  pk: string
  name: string
  v: number
  room?: RoomAd | null
  mm?: MMTicket | null
  offer?: MMOffer | null
}

export const MM_MODES: Record<MMMode, { label: string; maxHumans: number; teamSize: number; map: MapId }> = {
  rift: { label: '召唤师峡谷 5v5', maxHumans: 10, teamSize: 5, map: 'rift' },
  aram: { label: '极地大乱斗 5v5', maxHumans: 10, teamSize: 5, map: 'aram' },
}
/** wait at least this long for more players once 2+ are queued */
const MM_GATHER_MS = 8000

export class Lobby {
  readonly yr: YRoom
  private cbs = new Set<() => void>()
  private timer: number
  private handledOffers = new Set<string>()
  onMatched: ((offer: MMOffer, asOwner: boolean) => void) | null = null
  private state: LobbyState

  constructor(me: { pk: string; name: string }) {
    this.yr = new YRoom(LOBBY_ROOM)
    this.state = { pk: me.pk, name: me.name, v: APP_VERSION, room: null, mm: null, offer: null }
    this.push()
    this.yr.awareness.on('change', () => { for (const cb of this.cbs) cb() })
    this.yr.onStatus(() => { for (const cb of this.cbs) cb() })
    this.timer = window.setInterval(() => this.tick(), 1000)
  }

  private push() {
    this.yr.awareness.setLocalState({ ...this.state })
  }

  setName(name: string) {
    this.state.name = name
    this.push()
  }

  onChange(cb: () => void) {
    this.cbs.add(cb)
    return () => this.cbs.delete(cb)
  }

  get status() { return this.yr.status }

  private states(): [number, LobbyState][] {
    const out: [number, LobbyState][] = []
    for (const [cid, s] of this.yr.awareness.getStates()) {
      const st = s as LobbyState
      if (st && st.pk && st.v === APP_VERSION) out.push([cid, st])
    }
    return out
  }

  online() {
    return new Set(this.states().map(([, s]) => s.pk)).size
  }

  rooms(): RoomAd[] {
    const out: RoomAd[] = []
    for (const [, s] of this.states()) if (s.room) out.push(s.room)
    return out.sort((a, b) => (a.status === 'lobby' ? 0 : 1) - (b.status === 'lobby' ? 0 : 1) || b.since - a.since)
  }

  advertise(ad: RoomAd | null) {
    this.state.room = ad
    this.push()
  }

  // ------------------------------------------------------------ matchmaking
  get ticket() { return this.state.mm ?? null }

  queue(mode: MMMode, rating: number) {
    this.state.mm = { mode, since: Date.now(), rating }
    this.push()
  }
  cancelQueue() {
    this.state.mm = null
    this.push()
  }

  queued(mode: MMMode): [number, LobbyState][] {
    return this.states().filter(([, s]) => s.mm?.mode === mode).sort((a, b) => a[1].mm!.since - b[1].mm!.since || a[0] - b[0])
  }

  queueCount(mode: MMMode) {
    return this.queued(mode).length
  }

  private tick() {
    const mm = this.state.mm
    // clear stale own offer
    if (this.state.offer && Date.now() - this.state.offer.t > 30000) { this.state.offer = null; this.push() }
    if (!mm) return
    const myPk = this.state.pk
    // someone matched us?
    for (const [, s] of this.states()) {
      const o = s.offer
      if (!o || s.pk === myPk || this.handledOffers.has(o.room)) continue
      if (Date.now() - o.t > 30000) continue
      if (o.players.some(p => p.pk === myPk)) {
        this.handledOffers.add(o.room)
        this.state.mm = null
        this.push()
        this.onMatched?.(o, false)
        return
      }
    }
    // am I the matchmaker for this mode? (earliest ticket)
    const q = this.queued(mm.mode)
    if (!q.length || q[0][0] !== this.yr.clientId) return
    const cfg = MM_MODES[mm.mode]
    const oldest = Date.now() - q[0][1].mm!.since
    const humans = new Map<string, LobbyState>()
    for (const [, s] of q) if (!humans.has(s.pk)) humans.set(s.pk, s)
    const n = humans.size
    if (n < 2) return
    if (n < cfg.maxHumans && oldest < MM_GATHER_MS) return
    this.formMatch(mm.mode, [...humans.values()], false)
  }

  private formMatch(mode: MMMode, queued: LobbyState[], quick: boolean) {
    const cfg = MM_MODES[mode]
    const picked = queued.slice(0, cfg.maxHumans)
    // balance teams by rating (snake draft)
    const sorted = [...picked].sort((a, b) => (b.mm?.rating ?? 1000) - (a.mm?.rating ?? 1000))
    const pattern = [0, 1, 1, 0]
    const players = sorted.map((s, i) => ({ pk: s.pk, name: s.name, team: pattern[i % 4] as 0 | 1 }))
    const offer: MMOffer = { room: randId(6), mode, players, t: Date.now(), quick }
    this.handledOffers.add(offer.room)
    this.state.offer = offer
    this.state.mm = null
    this.push()
    this.onMatched?.(offer, true)
  }

  /** stop waiting: form a match right now with everyone currently queued for this mode (bots fill the rest) */
  startNow() {
    const mm = this.state.mm
    if (!mm) return
    const humans = new Map<string, LobbyState>()
    humans.set(this.state.pk, this.state)
    for (const [, s] of this.queued(mm.mode)) if (!humans.has(s.pk)) humans.set(s.pk, s)
    this.formMatch(mm.mode, [...humans.values()], true)
  }

  destroy() {
    clearInterval(this.timer)
    this.cbs.clear()
    this.yr.destroy()
  }
}
