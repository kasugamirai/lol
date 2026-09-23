import type { MatchRoom } from '../net/room'
import { World, INTERP_DELAY } from './world'
import { Champion, ChampSave } from './champion'
import { Minion, Monster, Ward } from './npc'
import { Unit } from './unit'
import { F, NetEvent } from './types'
import { MINION_TYPES, MinionType } from './data/units'
import { LaneId, MonsterType } from './mapdef'
import { dist } from '../util/math'

const SEND_MS = 66
const FRESH_MS = 4000
const LANES: LaneId[] = ['top', 'mid', 'bot']
const r2 = (v: number) => Math.round(v * 100) / 100

export interface ChampSnap {
  i: string; x: number; z: number; f: number; hp: number; mh: number; mp: number; mm: number; sh: number
  lv: number; fl: number; at: string; as: number; tp: number; rs: number
  k: number; d: number; a: number; cs: number; g: number; it: (string | null)[]; sk: number[]; xp: number; sp?: [string, string]
}

interface WorldSnap {
  t: number
  n: number
  wv: number
  nw: number
  ca: [string, number][]
  ia: [string, number][]
  ra: number[]
  m: any[][]
  j: any[][]
  wd: any[][]
  s: any[][]
  b: ChampSnap[]
  afk: string[]
  wn: number
}

interface RemoteState {
  pk: string
  name: string
  slot?: string | null
  inGame?: boolean
  synced?: boolean
  joinedAt?: number
  t?: number
  c?: ChampSnap
  w?: WorldSnap
  ev?: [number, NetEvent][]
}

export class NetGame {
  private seq = 0
  private outbox: { s: number; t: number; e: NetEvent }[] = []
  private lastSeen = new Map<number, number>()
  private lastRecv = new Map<number, number>()
  hostCid = -1
  private lastSend = 0
  private dirty = false
  readonly joinedAt = Date.now()
  private electAt = 0
  private saveAt = 0
  restored = false
  private startMs = performance.now()
  private synced = false
  private lastWorld: WorldSnap | null = null
  private afkSince = new Map<string, number>()
  private handler: (ch: { added: number[]; updated: number[]; removed: number[] }) => void
  peers = 0
  bytesOut = 0

  constructor(public room: MatchRoom, public w: World, public me: { pk: string; name: string }, public slot: string | null) {
    w.onEmit = ev => this.emit(ev)
    this.handler = ch => this.onAwareness(ch)
    room.yr.awareness.on('change', this.handler)
  }

  get cid() { return this.room.yr.clientId }
  get isHost() { return this.w.isHost }

  emit(ev: NetEvent) {
    this.outbox.push({ s: ++this.seq, t: performance.now(), e: ev })
    this.dirty = true
  }

  destroy() {
    this.room.yr.awareness.off('change', this.handler)
    this.w.onEmit = null
    const st = this.room.yr.awareness.getLocalState() as any
    if (st) this.room.yr.awareness.setLocalState({ pk: st.pk, name: st.name, slot: this.slot, inGame: false })
  }

  // ------------------------------------------------------------------ per frame
  tick(nowMs: number) {
    if (nowMs >= this.electAt) {
      this.electAt = nowMs + 250
      this.elect(nowMs)
    }
    if (!this.restored && (this.w.isHost || nowMs - this.startMs > 2500)) this.finishRestore(null)
    const since = nowMs - this.lastSend
    if (since >= SEND_MS || (this.dirty && since >= 30)) this.send(nowMs)
    if (this.restored && this.w.me && nowMs >= this.saveAt) {
      this.saveAt = nowMs + 10000
      const c = this.w.me
      const save: ChampSave = { lv: c.level, xp: Math.round(c.xp), g: Math.round(c.gold), it: c.items, sk: c.skillLv, k: c.kills, d: c.deaths, a: c.assists, cs: c.cs }
      this.room.saves.set(c.slot, save)
    }
    if (this.w.isHost && this.w.winner !== -1 && this.room.info?.status === 'playing') {
      this.room.setMeta({ status: 'ended', winner: this.w.winner })
    }
  }

  private send(nowMs: number) {
    const w = this.w
    this.outbox = this.outbox.filter(o => nowMs - o.t < 1600)
    const st: RemoteState = {
      pk: this.me.pk, name: this.me.name,
      slot: this.restored ? this.slot : null,
      inGame: true,
      synced: this.synced || w.isHost,
      joinedAt: this.joinedAt,
      t: Date.now(),
      ev: this.outbox.map(o => [o.s, o.e]),
    }
    if (w.me && this.restored) st.c = this.champSnap(w.me)
    if (w.isHost) st.w = this.worldSnap()
    this.room.yr.awareness.setLocalState(st)
    this.lastSend = nowMs
    this.dirty = false
  }

  // ------------------------------------------------------------------ election
  private elect(nowMs: number) {
    const cands: { cid: number; synced: boolean; joinedAt: number; slot: string | null }[] = [
      { cid: this.cid, synced: this.synced || this.w.isHost, joinedAt: this.joinedAt, slot: this.restored ? this.slot : null },
    ]
    for (const [cid, s0] of this.room.yr.awareness.getStates()) {
      const s = s0 as RemoteState
      if (cid === this.cid || !s?.inGame) continue
      const lr = this.lastRecv.get(cid)
      if (!lr || nowMs - lr > FRESH_MS) continue
      cands.push({ cid, synced: !!s.synced, joinedAt: s.joinedAt ?? 0, slot: s.slot ?? null })
    }
    this.peers = cands.length - 1
    cands.sort((a, b) => Number(b.synced) - Number(a.synced) || a.joinedAt - b.joinedAt || a.cid - b.cid)
    const host = cands[0].cid
    if (host !== this.hostCid) {
      const was = this.w.isHost
      this.hostCid = host
      const now = host === this.cid
      if (now && !was) this.becomeHost()
      else if (!now && was) this.resignHost(nowMs)
    }
    if (this.w.isHost) this.updateAfk(nowMs, new Set(cands.map(c => c.slot).filter(Boolean) as string[]))
  }

  private becomeHost() {
    const w = this.w
    this.synced = true
    const s = this.lastWorld
    const h = w.host
    if (s) {
      h.nextId = Math.max(h.nextId, s.n)
      h.wave = s.wv
      h.nextWaveAt = s.nw
      for (const c of w.map.camps) h.campAt.set(c.id, -1)
      for (const [id, at] of s.ca) h.campAt.set(id, at)
      // camps without monsters and without timers: respawn them soon
      for (const c of w.map.camps) {
        if (h.campAt.get(c.id) === -1 && ![...w.units.values()].some(u => u instanceof Monster && u.camp === c.id && !u.dead)) h.campAt.set(c.id, w.time + 5)
      }
      h.inhibAt.clear()
      for (const [id, at] of s.ia) h.inhibAt.set(id, at)
      h.relicAt = s.ra.slice()
      for (const id of s.afk) h.afk.add(id)
    }
    w.becomeHost()
    console.info('[net] became host')
  }

  private resignHost(nowMs: number) {
    this.w.resignHost(nowMs)
    console.info('[net] resigned host')
  }

  private updateAfk(nowMs: number, present: Set<string>) {
    const w = this.w
    let changed = false
    for (const c of w.champs) {
      if (c.isBot || c === w.me) continue
      if (present.has(c.slot)) {
        this.afkSince.delete(c.slot)
        if (w.host.afk.delete(c.slot)) changed = true
      } else {
        const t0 = this.afkSince.get(c.slot) ?? nowMs
        this.afkSince.set(c.slot, t0)
        if (nowMs - t0 > 6000 && !w.host.afk.has(c.slot)) { w.host.afk.add(c.slot); changed = true }
      }
    }
    if (changed) w.host.syncBots()
  }

  // ------------------------------------------------------------------ receiving
  private onAwareness({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) {
    const states = this.room.yr.awareness.getStates()
    const now = performance.now()
    for (const cid of [...added, ...updated]) {
      if (cid === this.cid) continue
      const s = states.get(cid) as RemoteState | undefined
      if (!s || !s.inGame) continue
      this.lastRecv.set(cid, now)
      // events
      const evs = s.ev
      if (evs && evs.length) {
        let last = this.lastSeen.get(cid)
        if (last === undefined) {
          last = 0
          for (const [sq] of evs) last = Math.max(last, sq)
        } else {
          for (const [sq, e] of evs) {
            if (sq <= last) continue
            last = sq
            try { this.w.handleEvent(e, true) } catch (err) { console.warn('event failed', e, err) }
          }
        }
        this.lastSeen.set(cid, last)
      } else if (!this.lastSeen.has(cid)) this.lastSeen.set(cid, 0)
      // champion
      if (s.c && s.slot) {
        const ch = this.w.unit(s.slot)
        if (ch instanceof Champion && ch !== this.w.me) {
          if (this.w.isHost && this.w.host.afk.delete(s.slot)) this.w.host.syncBots()
          if (!ch.local) this.applyChamp(ch, s.c, now)
        }
      }
      // world
      if (s.w && cid === this.hostCid && !this.w.isHost) this.applyWorld(s.w, now)
      else if (s.w && !this.w.isHost && this.hostCid === -1) this.lastWorld = s.w
    }
    for (const cid of removed) this.lastRecv.delete(cid)
  }

  private finishRestore(snap: WorldSnap | null) {
    if (this.restored) return
    this.restored = true
    const me = this.w.me
    if (!me) return
    const fromHost = snap?.b.find(b => b.i === me.id)
    if (fromHost) {
      me.restore({ lv: fromHost.lv, xp: fromHost.xp, g: fromHost.g, it: fromHost.it, sk: fromHost.sk, k: fromHost.k, d: fromHost.d, a: fromHost.a, cs: fromHost.cs })
      if (!(fromHost.fl & F.DEAD)) {
        me.x = fromHost.x; me.z = fromHost.z
        me.hp = Math.min(me.maxHp, fromHost.hp)
        me.mp = Math.min(me.maxMp, fromHost.mp)
      } else {
        me.dead = true
        me.respawnAt = this.w.now + Math.max(1, fromHost.rs)
      }
      me.tp++
      return
    }
    const save = this.room.saves.get(me.slot)
    if (save && this.w.time > 5) {
      me.restore(save)
      me.hp = me.maxHp
      me.mp = me.maxMp
    }
  }

  // ------------------------------------------------------------------ snapshots
  champSnap(c: Champion): ChampSnap {
    const w = this.w
    return {
      i: c.id, x: r2(c.x), z: r2(c.z), f: r2(c.facing), hp: Math.round(c.hp), mh: Math.round(c.maxHp), mp: Math.round(c.mp), mm: Math.round(c.maxMp),
      sh: Math.round(c.shieldTotal()), lv: c.level, fl: c.fl, at: c.targetId ?? '', as: c.atkSeq, tp: c.tp,
      rs: c.dead ? Math.round((c.respawnAt - w.now) * 10) / 10 : 0,
      k: c.kills, d: c.deaths, a: c.assists, cs: c.cs, g: Math.round(c.gold), it: c.items, sk: c.skillLv, xp: Math.round(c.xp), sp: c.spells,
    }
  }

  private worldSnap(): WorldSnap {
    const w = this.w
    const h = w.host
    const m: any[][] = [], j: any[][] = [], wd: any[][] = [], s: any[][] = []
    for (const u of w.units.values()) {
      if (u instanceof Minion) {
        m.push([u.id, MINION_TYPES.indexOf(u.mt), u.team, LANES.indexOf(u.lane), r2(u.x), r2(u.z), r2(u.facing), Math.round(u.hp), u.maxHp, u.fl, u.targetId ?? '', u.atkSeq])
      } else if (u instanceof Monster) {
        j.push([u.id, u.mt, u.camp, r2(u.x), r2(u.z), r2(u.facing), Math.round(u.hp), u.maxHp, u.fl, u.targetId ?? '', u.atkSeq])
      } else if (u instanceof Ward) {
        wd.push([u.id, u.team, r2(u.x), r2(u.z), u.hp, Math.round(u.expires - w.now), u.fl])
      } else if (u.isStructure) {
        s.push([u.id, Math.round(u.hp), u.dead ? 1 : 0, u.targetId ?? '', u.atkSeq])
      }
    }
    const b: ChampSnap[] = []
    for (const c of w.champs) if (c.local && c !== w.me) b.push(this.champSnap(c))
    return {
      t: Math.round(w.time * 100) / 100, n: h.nextId, wv: h.wave, nw: h.nextWaveAt,
      ca: [...h.campAt.entries()].filter(([, v]) => v >= 0),
      ia: [...h.inhibAt.entries()],
      ra: h.relicAt.map(v => Math.round(v)),
      m, j, wd, s, b, afk: [...h.afk], wn: w.winner,
    }
  }

  private applyWorld(s: WorldSnap, now: number) {
    const w = this.w
    this.lastWorld = s
    if (!this.synced) this.synced = true
    // time
    const diff = s.t - w.time
    if (Math.abs(diff) > 1.5) w.time = s.t
    else w.time += diff * 0.1
    w.host.relicAt = s.ra
    s.ra.forEach((at, i) => (w.relicsUp[i] = at <= w.time))
    if (s.wn !== -1 && w.winner === -1) w.setWinner(s.wn as 0 | 1)
    const seen = new Set<string>()
    const dyn = (u: Unit, fl: number, tgt: string, as: number, hp: number, mhp: number) => {
      u.hp = hp
      u.stats.maxHp = mhp
      const wasDead = u.dead
      u.fl = fl
      u.dead = !!(fl & F.DEAD)
      if (u.dead && !wasDead) u.deadAt = w.now
      if (as !== u.atkSeq) {
        if (u.seenAtkSeq > 0 || u.atkSeq > 0) this.remoteAttack(u, tgt)
        u.atkSeq = as
      }
      u.seenAtkSeq = 1
      u.targetId = tgt || null
    }
    for (const e of s.m) {
      const [id, mti, team, li, x, z, f, hp, mhp, fl, tgt, as] = e
      seen.add(id)
      let u = w.unit(id) as Minion | null
      if (!u) {
        const lane = LANES[li]
        u = new Minion(id, MINION_TYPES[mti] as MinionType, team, lane, w.map.lanes[lane] ?? w.map.lanes.mid!, x, z, 0)
        u.local = false
        u.facing = f
        u.interp.reset(now, x, z, f)
        u.atkSeq = as
        w.addUnit(u)
      }
      u.interp.push(now, x, z, f)
      dyn(u, fl, tgt, as, hp, mhp)
    }
    for (const e of s.j) {
      const [id, mt, camp, x, z, f, hp, mhp, fl, tgt, as] = e
      seen.add(id)
      let u = w.unit(id) as Monster | null
      if (!u) {
        const cd = w.map.camps.find(c => c.id === camp)
        let hx = x, hz = z
        if (cd) {
          let bd = Infinity
          for (const md of cd.monsters) {
            if (md.type !== mt) continue
            const d = dist(x, z, cd.x + md.dx, cd.z + md.dz)
            if (d < bd) { bd = d; hx = cd.x + md.dx; hz = cd.z + md.dz }
          }
        }
        u = new Monster(id, mt as MonsterType, camp, hx, hz, cd?.face ?? 0, w.time, !!cd?.epic)
        u.x = x; u.z = z
        u.local = false
        u.interp.reset(now, x, z, f)
        u.atkSeq = as
        w.addUnit(u)
      }
      u.interp.push(now, x, z, f)
      dyn(u, fl, tgt, as, hp, mhp)
    }
    for (const e of s.wd) {
      const [id, team, x, z, hp, rem, fl] = e
      seen.add(id)
      let u = w.unit(id) as Ward | null
      if (!u) {
        u = new Ward(id, team, x, z, w.now)
        u.local = false
        u.interp.reset(now, x, z, 0)
        w.addUnit(u)
      }
      u.expires = w.now + rem
      u.hp = hp
      u.fl = fl
      u.dead = !!(fl & F.DEAD)
    }
    for (const u of [...w.units.values()]) {
      if (u.local || seen.has(u.id)) continue
      if (u.kind === 'minion' || u.kind === 'monster' || u.kind === 'ward') {
        if (!u.dead) { u.dead = true; u.deadAt = w.now }
        if (w.now - u.deadAt > 1.6) w.removeUnit(u)
      }
    }
    for (const e of s.s) {
      const [id, hp, dead, tgt, as] = e
      const u = w.unit(id)
      if (!u) continue
      const wasDead = u.dead
      u.hp = hp
      u.dead = !!dead
      if (u.dead && !wasDead) u.deadAt = w.now
      if (as !== u.atkSeq) {
        if (u.seenAtkSeq > 0) this.remoteAttack(u, tgt)
        u.atkSeq = as
      }
      u.seenAtkSeq = 1
      u.targetId = tgt || null
    }
    for (const b of s.b) {
      const c = w.unit(b.i)
      if (c instanceof Champion && !c.local) this.applyChamp(c, b, now)
    }
    if (!this.restored) this.finishRestore(s)
  }

  private applyChamp(c: Champion, s: ChampSnap, now: number) {
    const w = this.w
    c.interp.push(now, s.x, s.z, s.f, s.tp)
    const itemsChanged = c.items.join() !== s.it.join()
    const lvChanged = c.level !== s.lv
    c.level = s.lv
    c.items = s.it.slice()
    c.skillLv = s.sk.slice()
    if (s.sp) c.spells = s.sp
    if (itemsChanged || lvChanged) c.recalc()
    c.hp = s.hp
    c.stats.maxHp = s.mh
    c.mp = s.mp
    c.stats.maxMp = s.mm
    c.shieldR = s.sh
    const wasDead = c.dead
    c.fl = s.fl
    c.dead = !!(s.fl & F.DEAD)
    if (c.dead && !wasDead) c.deadAt = w.now
    c.respawnRemain = s.rs
    c.kills = s.k; c.deaths = s.d; c.assists = s.a; c.cs = s.cs; c.gold = s.g; c.xp = s.xp
    if (s.as !== c.atkSeq) {
      if (c.seenAtkSeq > 0) this.remoteAttack(c, s.at)
      c.atkSeq = s.as
    }
    c.seenAtkSeq = 1
    c.targetId = s.at || null
  }

  /** replay a remote basic attack for visuals */
  private remoteAttack(u: Unit, tgtId: string) {
    const w = this.w
    const delay = INTERP_DELAY / 1000
    const t = w.unit(tgtId)
    w.after(delay, () => { u.animAtk = w.now })
    if (!t) return
    let windup = 0.25, speed = 0, vis: any = null, y = 1.2
    if (u instanceof Champion) {
      windup = u.def.windup / Math.max(0.3, u.stats.as || 0.7)
      if (!u.def.melee) { speed = u.def.proj; vis = u.def.projVis }
    } else if (u instanceof Minion) {
      windup = u.def.windup
      if (u.def.proj) { speed = u.def.proj; vis = { kind: u.mt === 'siege' ? 'cannon' : 'orb', color: u.team === 0 ? 0x6ab0ff : 0xff6a6a, size: u.mt === 'siege' ? 0.4 : 0.22 } }
    } else if (u instanceof Monster) {
      windup = u.def.windup
      if (u.def.proj) { speed = u.def.proj; vis = { kind: u.mt === 'dragon' ? 'breath' : 'spit', color: u.mt === 'dragon' ? 0xff7a2a : u.mt === 'baron' ? 0xb05aff : 0x8aff5a, size: 0.6 } ; y = u.height * 0.6 }
    } else if (u.kind === 'tower') {
      windup = 0; speed = 16; y = 6.2
      vis = { kind: 'tower', color: u.team === 0 ? 0x7ac0ff : 0xff7a6a, size: 0.55, trail: true }
      w.hooks.sound?.('tower', u.x, u.z)
    }
    w.after(delay + windup, () => {
      if (u.dead && !u.isStructure) return
      if (vis && speed > 0) {
        w.spawnProjectile({
          srcId: u.id, src: u, team: u.team, x: u.x, z: u.z, y, dx: 0, dz: 0, speed, homing: t, maxDist: 999,
          width: 0.2, pierce: 1, auth: false, vis, filter: () => false,
        })
      } else {
        w.fx({ kind: 'slash', x: t.x, z: t.z, r: 1, dir: u.facing, color: 0xffffff, dur: 0.22 })
        if (u.isChamp) w.hooks.sound?.('hit', t.x, t.z)
      }
    })
  }
}
