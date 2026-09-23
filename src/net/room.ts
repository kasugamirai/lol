import * as Y from 'yjs'
import { YRoom } from './yroom'
import { ROOM_PREFIX } from '../config'
import type { MapId } from '../game/mapdef'
import { randId } from '../util/math'
import { CHAMPIONS } from '../game/data/champions'
import type { ChampSave } from '../game/champion'
import { verifyRoomProof } from '../nostr/identity'

export type RoomStatus = 'lobby' | 'playing' | 'ended'

export interface RoomMeta {
  id: string
  name: string
  map: MapId
  teamSize: number
  owner: string
  ownerName: string
  status: RoomStatus
  createdAt: number
  startedAt?: number
  gameId?: string
  seed?: number
  winner?: number
  botDiff: number
  priv?: boolean
  mm?: boolean
  quick?: boolean
  expected?: string[]
}

export interface SlotInfo {
  kind: 'human' | 'bot'
  pk?: string
  name: string
  champ: string | null
  spells: [string, string]
  ready: boolean
  diff?: number
  auth?: any
}

export interface ChatMsg {
  n: string
  pk: string
  t: string
  ts: number
  tm: number // -1 all
  sys?: boolean
}

export interface PresenceState {
  pk: string
  name: string
  slot?: string | null
  inGame?: boolean
  joinedAt?: number
  t?: number
  [k: string]: any
}

export const slotKeys = (size: number) => {
  const out: string[] = []
  for (let i = 0; i < size; i++) out.push('b' + i)
  for (let i = 0; i < size; i++) out.push('r' + i)
  return out
}
export const slotTeam = (k: string) => (k[0] === 'b' ? 0 : 1) as 0 | 1

export const BOT_NAMES = ['铁壁', '疾影', '炎心', '霜刃', '雷鸣', '星陨', '夜枭', '赤焰', '苍狼', '玄武', '青鸾', '白虎']

export class MatchRoom {
  readonly yr: YRoom
  readonly meta: Y.Map<any>
  readonly slots: Y.Map<SlotInfo>
  readonly chat: Y.Array<ChatMsg>
  readonly saves: Y.Map<ChampSave>
  private cbs = new Set<() => void>()

  constructor(public readonly id: string) {
    this.yr = new YRoom(ROOM_PREFIX + id)
    const d = this.yr.doc
    this.meta = d.getMap('meta')
    this.slots = d.getMap('slots')
    this.chat = d.getArray('chat')
    this.saves = d.getMap('saves')
    const fire = () => { for (const cb of this.cbs) cb() }
    this.meta.observe(fire)
    this.slots.observeDeep(fire)
    this.yr.awareness.on('change', fire)
  }

  static newId() { return randId(6) }

  whenSyncedOrTimeout(ms = 5000) { return this.yr.whenSynced(ms) }

  onChange(cb: () => void) {
    this.cbs.add(cb)
    return () => this.cbs.delete(cb)
  }

  get info(): RoomMeta | null {
    if (!this.meta.get('id')) return null
    return this.meta.toJSON() as RoomMeta
  }

  create(m: Omit<RoomMeta, 'status' | 'createdAt'>) {
    this.yr.doc.transact(() => {
      for (const [k, v] of Object.entries(m)) this.meta.set(k, v)
      this.meta.set('status', 'lobby')
      this.meta.set('createdAt', Date.now())
    })
  }

  setMeta(patch: Partial<RoomMeta>) {
    this.yr.doc.transact(() => {
      for (const [k, v] of Object.entries(patch)) this.meta.set(k, v)
    })
  }

  /** all awareness states in this room */
  presence(): Map<number, PresenceState> {
    const out = new Map<number, PresenceState>()
    for (const [cid, s] of this.yr.awareness.getStates()) if (s && (s as any).pk) out.set(cid, s as PresenceState)
    return out
  }
  onlinePks(): Set<string> {
    const s = new Set<string>()
    for (const p of this.presence().values()) s.add(p.pk)
    return s
  }

  slotOf(pk: string): string | null {
    for (const [k, v] of this.slots.entries()) if (v.kind === 'human' && v.pk === pk) return k
    return null
  }

  entries(): [string, SlotInfo][] {
    const size = this.info?.teamSize ?? 5
    return slotKeys(size).map(k => [k, this.slots.get(k)!] as [string, SlotInfo]).filter(e => !!e[1])
  }

  freeSlot(preferTeam?: 0 | 1): string | null {
    const size = this.info?.teamSize ?? 5
    const keys = slotKeys(size)
    const count = (t: 0 | 1) => keys.filter(k => slotTeam(k) === t && this.slots.get(k)?.kind === 'human').length
    const teams: (0 | 1)[] = preferTeam !== undefined ? [preferTeam, (1 - preferTeam) as 0 | 1] : count(0) <= count(1) ? [0, 1] : [1, 0]
    for (const t of teams) {
      for (const k of keys) if (slotTeam(k) === t && !this.slots.get(k)) return k
    }
    // replace a bot
    for (const t of teams) {
      for (const k of keys) if (slotTeam(k) === t && this.slots.get(k)?.kind === 'bot') return k
    }
    return null
  }

  claim(key: string, me: { pk: string; name: string; auth?: any }, keep?: Partial<SlotInfo>) {
    const prev = this.slotOf(me.pk)
    const old = prev ? this.slots.get(prev) : null
    this.yr.doc.transact(() => {
      if (prev && prev !== key) this.slots.delete(prev)
      this.slots.set(key, {
        kind: 'human', pk: me.pk, name: me.name, champ: keep?.champ ?? old?.champ ?? null,
        spells: keep?.spells ?? old?.spells ?? ['flash', 'heal'], ready: false, auth: me.auth,
      })
    })
  }

  leaveSlot(pk: string) {
    const k = this.slotOf(pk)
    if (k) this.slots.delete(k)
  }

  update(key: string, patch: Partial<SlotInfo>) {
    const cur = this.slots.get(key)
    if (!cur) return
    this.slots.set(key, { ...cur, ...patch })
  }

  addBot(key: string, diff: number) {
    const used = new Set([...this.slots.values()].map(s => s.name))
    const name = 'AI·' + (BOT_NAMES.find(n => !used.has('AI·' + n)) ?? randId(3))
    this.slots.set(key, { kind: 'bot', name, champ: null, spells: ['flash', 'heal'], ready: true, diff })
  }

  fillBots(diff: number) {
    const size = this.info?.teamSize ?? 5
    this.yr.doc.transact(() => {
      for (const k of slotKeys(size)) if (!this.slots.get(k)) this.addBot(k, diff)
    })
  }

  removeSlot(key: string) {
    this.slots.delete(key)
  }

  say(msg: Omit<ChatMsg, 'ts'>) {
    this.chat.push([{ ...msg, ts: Date.now() }])
    if (this.chat.length > 120) this.chat.delete(0, this.chat.length - 100)
  }

  /** owner: pick champions for bots / idle humans and flip to playing */
  start() {
    const info = this.info
    if (!info) return
    this.yr.doc.transact(() => {
      const byTeam: Record<number, Set<string>> = { 0: new Set(), 1: new Set() }
      for (const [k, s] of this.slots.entries()) if (s.champ) byTeam[slotTeam(k)].add(s.champ)
      for (const [k, s] of [...this.slots.entries()]) {
        if (s.champ) continue
        const t = slotTeam(k)
        const pool = CHAMPIONS.filter(c => !byTeam[t].has(c.id))
        const pick = (pool.length ? pool : CHAMPIONS)[Math.floor(Math.random() * (pool.length || CHAMPIONS.length))]
        byTeam[t].add(pick.id)
        this.slots.set(k, { ...s, champ: pick.id, spells: s.kind === 'bot' ? ['flash', Math.random() < 0.5 ? 'heal' : 'ignite'] : s.spells })
      }
      this.saves.clear()
      this.meta.set('status', 'playing')
      this.meta.set('startedAt', Date.now())
      this.meta.set('gameId', randId(10))
      this.meta.set('seed', Math.floor(Math.random() * 1e9))
      this.meta.delete('winner')
    })
  }

  backToLobby() {
    this.yr.doc.transact(() => {
      this.meta.set('status', 'lobby')
      for (const [k, s] of [...this.slots.entries()]) if (s.kind === 'human') this.slots.set(k, { ...s, ready: false })
    })
  }

  private vcache = new Map<string, boolean>()
  verified(s: SlotInfo): boolean {
    if (!s.pk || !s.auth?.id) return false
    const key = s.auth.id + s.pk
    let v = this.vcache.get(key)
    if (v === undefined) { v = verifyRoomProof(s.auth, s.pk, this.id); this.vcache.set(key, v) }
    return v
  }

  destroy() {
    this.cbs.clear()
    this.yr.destroy()
  }
}
