import { Grid } from './grid'
import { MapDef, MapId, getMap, LaneId } from './mapdef'
import { Unit, nextLocalId } from './unit'
import { Champion } from './champion'
import { F, HitPayload, NetEvent, Team } from './types'
import { applyHit } from './combat'
import { dist, dist2 } from '../util/math'
import { Vision } from './vision'
import { TOWERS, TOWER_RADIUS, INHIB, NEXUS, VISION } from './data/units'
import { handleDeathRewards } from './rewards'
import { HostLogic } from './hostlogic'
import { runRemoteCast } from './skills'

export interface SlotConfig {
  slot: string // b0..b4 / r0..r4
  team: 0 | 1
  champ: string
  name: string
  pk?: string
  bot: boolean
  spells: [string, string]
  diff?: number
}

export interface ProjVis {
  kind: 'arrow' | 'orb' | 'blade' | 'bolt' | 'rock' | 'fire' | 'ice' | 'star' | 'spear' | 'shard' | 'cannon' | 'tower' | 'spit' | 'breath'
  color: number
  size: number
  trail?: boolean
}

export interface Projectile {
  id: number
  srcId: string
  src: Unit | null
  team: Team
  x: number
  z: number
  y: number
  dx: number
  dz: number
  speed: number
  homing: Unit | null
  maxDist: number
  traveled: number
  width: number
  pierce: number
  hitIds: Set<string>
  auth: boolean
  vis: ProjVis
  filter: (u: Unit) => boolean
  onHit?: (t: Unit, p: Projectile) => void
  onEnd?: (p: Projectile, hit: boolean) => void
  dead: boolean
  anyHit: boolean
  born: number
}

export type EffectKind =
  | 'telegraph' | 'burst' | 'zone' | 'beam' | 'line' | 'cone' | 'nova' | 'trail' | 'flash' | 'heal' | 'shieldfx'
  | 'levelup' | 'mark' | 'spin' | 'hitspark' | 'ring' | 'global' | 'pillar' | 'death' | 'slash' | 'click' | 'ping' | 'recallfx' | 'buffglow' | 'explosion'

export interface Effect {
  id: number
  kind: EffectKind
  x: number
  z: number
  r: number
  len?: number
  dir?: number
  color: number
  t0: number
  dur: number
  follow?: Unit | null
  team?: Team
  data?: any
}

export interface FloatText {
  x: number; y: number; z: number
  text: string
  color: string
  size: number
  t0: number
  dur: number
  vy?: number
}

export interface WorldHooks {
  float?(ft: FloatText): void
  killFeed?(killer: Unit | null, victim: Unit, assists: string[]): void
  announce?(text: string, sub?: string, color?: string): void
  sound?(name: string, x?: number, z?: number): void
  ping?(team: Team, x: number, z: number, kind: number): void
  chat?(name: string, text: string, team: Team, all: boolean): void
  gameOver?(winner: Team): void
}

export const INTERP_DELAY = 110

export class World {
  map: MapDef
  grid: Grid
  now = 0
  time = 0
  realMs = 0
  isHost = false
  mySlot: string | null
  me: Champion | null = null
  myTeam: Team = 0
  spectator = false
  units = new Map<string, Unit>()
  champs: Champion[] = []
  towers: Unit[] = []
  structs: Unit[] = []
  projectiles: Projectile[] = []
  effects: Effect[] = []
  private timers: { at: number; fn: () => void }[] = []
  hooks: WorldHooks = {}
  onEmit: ((ev: NetEvent) => void) | null = null
  vision: Vision
  host: HostLogic
  slots: SlotConfig[]
  winner: Team | -1 = -1
  firstBlood = false
  teamKills: [number, number] = [0, 0]
  dragons: [number, number] = [0, 0]
  barons: [number, number] = [0, 0]
  towersKilled: [number, number] = [0, 0]
  /** units that attacked an enemy champion recently: used by tower aggro */
  private hash = new Map<number, Unit[]>()
  private hashCell = 6
  relicsUp: boolean[] = []

  constructor(mapId: MapId, slots: SlotConfig[], mySlot: string | null, public seed: number) {
    this.map = getMap(mapId)
    this.grid = new Grid(this.map)
    this.slots = slots
    this.mySlot = mySlot
    this.spectator = !mySlot
    this.vision = new Vision(this)
    this.host = new HostLogic(this)
    this.initStructures()
    for (const s of slots) {
      const c = new Champion(this, s)
      this.addUnit(c)
      this.champs.push(c)
      if (s.slot === mySlot) { this.me = c; this.myTeam = s.team; c.local = true }
    }
    this.relicsUp = this.map.relics.map(() => true)
  }

  private initStructures() {
    const m = this.map
    for (const t of m.towers) {
      const d = TOWERS[t.tier]
      const u = new Unit(t.id, 'tower', String(t.tier), t.team, t.x, t.z, TOWER_RADIUS)
      u.stats.maxHp = d.hp; u.hp = d.hp; u.stats.ad = d.ad; u.stats.armor = d.armor; u.stats.mr = d.mr
      u.name = d.name
      u.height = 7
      this.addUnit(u)
      this.towers.push(u)
      this.grid.blockCircle(t.x, t.z, TOWER_RADIUS + 0.2)
    }
    for (const s of m.structs) {
      const d = s.kind === 'nexus' ? NEXUS : INHIB
      const u = new Unit(s.id, s.kind, s.lane ?? 'base', s.team, s.x, s.z, d.radius)
      u.stats.maxHp = d.hp; u.hp = d.hp; u.stats.armor = d.armor; u.stats.mr = d.mr
      u.name = d.name
      u.height = s.kind === 'nexus' ? 6 : 3
      this.addUnit(u)
      this.structs.push(u)
      this.grid.blockCircle(s.x, s.z, d.radius + 0.1)
    }
  }

  /** take authority over all world-owned units (minions, towers, monsters, bots) */
  becomeHost() {
    this.isHost = true
    for (const u of this.units.values()) {
      if (u instanceof Champion) continue
      u.local = true
      u.windup = 0
    }
    this.host.syncBots()
  }

  resignHost(nowMs: number) {
    this.isHost = false
    for (const u of this.units.values()) {
      if (u instanceof Champion) continue
      u.local = false
      u.interp.reset(nowMs, u.x, u.z, u.facing)
    }
    this.host.afk.clear()
    this.host.syncBots()
    for (const c of this.champs) if (!c.local) c.interp.reset(nowMs, c.x, c.z, c.facing)
  }

  addUnit(u: Unit) {
    this.units.set(u.id, u)
  }
  removeUnit(u: Unit) {
    this.units.delete(u.id)
  }
  unit(id: string | null | undefined) {
    return id ? this.units.get(id) ?? null : null
  }

  // ---------------- timers & effects ----------------
  after(sec: number, fn: () => void) {
    this.timers.push({ at: this.now + sec, fn })
  }
  fx(e: Omit<Effect, 'id' | 't0'> & { t0?: number }) {
    const eff: Effect = { id: nextLocalId(), t0: this.now, ...e }
    this.effects.push(eff)
    return eff
  }
  float(x: number, z: number, text: string, color: string, size = 16, y = 2.2) {
    this.hooks.float?.({ x, y, z, text, color, size, t0: this.now, dur: 1.1 })
  }

  // ---------------- networking ----------------
  emit(ev: NetEvent) {
    this.onEmit?.(ev)
  }
  /** events from remote clients, or emitted locally and also relevant to this client */
  handleEvent(ev: NetEvent, remote: boolean) {
    switch (ev.e) {
      case 'cast': {
        if (!remote) return
        const u = this.unit(ev.s)
        if (!u || u.local) return
        runRemoteCast(this, u, ev)
        return
      }
      case 'hit': {
        const u = this.unit(ev.tgt)
        const src = this.unit(ev.src)
        if (src && u && u.isChamp && src.team !== u.team && (src.isChamp)) {
          src.lastAttackedChamp = this.now
          src.lastAttackedChampTarget = u.id
        }
        if (u && u.local) applyHit(this, u, ev)
        return
      }
      case 'heal': {
        const u = this.unit(ev.tgt)
        if (u && u.local && !u.dead) this.healUnit(u, ev.a, true)
        return
      }
      case 'buff': {
        const u = this.unit(ev.tgt)
        if (u && u.local) u.addBuff(this.now, ev.b, ev.src)
        return
      }
      case 'death':
        handleDeathRewards(this, ev)
        return
      case 'ward':
        if (this.isHost) this.host.spawnWard(ev.tm, ev.x, ev.z)
        return
      case 'relic':
        if (this.isHost) this.host.takeRelic(ev.id, ev.by)
        return
      case 'ping':
        if (ev.tm === this.myTeam || this.spectator) this.hooks.ping?.(ev.tm, ev.x, ev.z, ev.pk)
        return
      case 'chat':
        if (ev.all || ev.tm === this.myTeam || this.spectator) this.hooks.chat?.(ev.n, ev.t, ev.tm, !!ev.all)
        return
      case 'end':
        this.setWinner(ev.w)
        return
      case 'lvl': {
        const u = this.unit(ev.s)
        if (u && !u.local) this.fx({ kind: 'levelup', x: u.x, z: u.z, r: 1.2, color: 0xffd76a, dur: 1.2, follow: u })
        return
      }
    }
  }

  setWinner(w: Team) {
    if (this.winner !== -1) return
    this.winner = w
    const nexus = this.structs.find(s => s.kind === 'nexus' && s.team !== w)
    if (nexus) {
      nexus.dead = true
      nexus.hp = 0
      this.fx({ kind: 'explosion', x: nexus.x, z: nexus.z, r: 8, color: nexus.team === 0 ? 0x66aaff : 0xff6666, dur: 2.5 })
    }
    this.hooks.sound?.('nexus')
    this.after(2.2, () => this.hooks.gameOver?.(w))
  }

  /** send a hit to the target's owner (or apply locally) */
  sendHit(target: Unit, hit: HitPayload) {
    if (target.local) applyHit(this, target, hit)
    else this.emit({ e: 'hit', ...hit })
    const src = this.unit(hit.src)
    if (src && target.isChamp && src.team !== target.team) {
      src.lastAttackedChamp = this.now
      src.lastAttackedChampTarget = target.id
    }
  }

  healUnit(u: Unit, amount: number, show: boolean) {
    if (u.dead) return 0
    let a = amount
    if (u.hasBuff('grievous')) a *= 0.6
    if (u instanceof Champion) a *= 1 + u.stats.heal
    const before = u.hp
    u.hp = Math.min(u.maxHp, u.hp + a)
    const got = u.hp - before
    if (show && got >= 1 && (u === this.me)) this.float(u.x, u.z, `+${Math.round(got)}`, '#6bff7a', 15, 2.6)
    return got
  }

  // ---------------- queries ----------------
  private rebuildHash() {
    this.hash.clear()
    const c = this.hashCell
    for (const u of this.units.values()) {
      if (u.dead) continue
      const k = Math.floor(u.x / c) * 1000 + Math.floor(u.z / c)
      let arr = this.hash.get(k)
      if (!arr) this.hash.set(k, (arr = []))
      arr.push(u)
    }
  }
  /** alive units within r (center distance) — includes structures */
  near(x: number, z: number, r: number, out: Unit[] = []): Unit[] {
    out.length = 0
    const c = this.hashCell
    const i0 = Math.floor((x - r - 3.5) / c), i1 = Math.floor((x + r + 3.5) / c)
    const j0 = Math.floor((z - r - 3.5) / c), j1 = Math.floor((z + r + 3.5) / c)
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const arr = this.hash.get(i * 1000 + j)
      if (!arr) continue
      for (const u of arr) {
        const rr = r + u.radius
        if (dist2(x, z, u.x, u.z) <= rr * rr) out.push(u)
      }
    }
    return out
  }

  isEnemy(a: Team, b: Team) {
    return a !== b
  }

  /** can `team` currently see unit u */
  canSee(team: Team, u: Unit) {
    if (u.team === team) return true
    if (u.isStructure) return true
    if (team === 2) return true
    return u.vis[team as 0 | 1]
  }
  /** visible to the local viewer */
  visibleToMe(u: Unit) {
    if (this.spectator) return !(u.has(F.STEALTH) && false)
    return this.canSee(this.myTeam, u)
  }

  inFountain(team: 0 | 1, x: number, z: number, extra = 0) {
    const f = this.map.fountains[team]
    return dist(x, z, f.x, f.z) <= f.r + 4 + extra
  }
  inShop(team: 0 | 1, x: number, z: number) {
    const f = this.map.fountains[team]
    return dist(x, z, f.x, f.z) <= this.map.shopRadius
  }
  nexusOf(team: Team) {
    return this.structs.find(s => s.kind === 'nexus' && s.team === team) ?? null
  }

  /** is the structure currently protected (previous tier alive) */
  isProtected(s: Unit): boolean {
    if (s.kind === 'tower') {
      const tier = Number(s.type)
      const def = this.map.towers.find(t => t.id === s.id)!
      if (tier === 1) return false
      if (tier === 2 || tier === 3) {
        const prev = this.towers.find(t => t.team === s.team && this.map.towers.find(d => d.id === t.id)!.lane === def.lane && Number(t.type) === tier - 1)
        return !!prev && !prev.dead
      }
      // nexus towers: need at least one inhibitor down
      return !this.structs.some(i => i.kind === 'inhib' && i.team === s.team && i.dead)
    }
    if (s.kind === 'inhib') {
      const t3 = this.towers.find(t => t.team === s.team && Number(t.type) === 3 && this.map.towers.find(d => d.id === t.id)!.lane === s.type)
      if (t3) return !t3.dead
      // aram: the inhib tower id is tier 3 as well
      return false
    }
    if (s.kind === 'nexus') {
      return this.towers.some(t => t.team === s.team && Number(t.type) === 4 && !t.dead)
    }
    return false
  }

  laneOfTowerAhead(team: Team, lane: LaneId) {
    return this.towers.filter(t => t.team !== team && !t.dead && this.map.towers.find(d => d.id === t.id)!.lane === lane)
  }

  // ---------------- main update ----------------
  update(dt: number, realMs: number) {
    this.now += dt
    this.realMs = realMs
    if (this.isHost) this.time += dt
    else this.time += dt // corrected by snapshots

    // timers
    if (this.timers.length) {
      const due = this.timers.filter(t => t.at <= this.now)
      if (due.length) {
        this.timers = this.timers.filter(t => t.at > this.now)
        for (const t of due) t.fn()
      }
    }
    this.rebuildHash()

    const rt = realMs - INTERP_DELAY
    const tmp = { x: 0, z: 0, f: 0, v: 0 }
    for (const u of this.units.values()) {
      if (u.local) continue
      if (u.isStructure) continue
      if (!u.interp.empty && u.interp.sample(rt, tmp)) {
        u.x = tmp.x; u.z = tmp.z; u.facing = tmp.f
        u.speedNow = tmp.v
        u.moving = tmp.v > 0.3 && !u.dead
      }
      u.airY = u.has(F.KNOCKUP) ? Math.max(0, u.airY + (1.3 - u.airY) * Math.min(1, dt * 10)) : Math.max(0, u.airY - dt * 6)
    }

    if (this.isHost) this.host.update(dt)
    for (const c of this.champs) if (c.local) c.update(dt)

    this.updateProjectiles(dt)
    // velocity estimate (bot aim prediction)
    if (dt > 0) {
      for (const u of this.units.values()) {
        if (!Number.isNaN(u.px)) {
          const vx = (u.x - u.px) / dt, vz = (u.z - u.pz) / dt
          if (Math.abs(vx) < 40 && Math.abs(vz) < 40) { u.vx = u.vx * 0.75 + vx * 0.25; u.vz = u.vz * 0.75 + vz * 0.25 }
          else { u.vx = 0; u.vz = 0 }
        }
        u.px = u.x; u.pz = u.z
      }
    }
    // expire effects
    if (this.effects.length) this.effects = this.effects.filter(e => this.now - e.t0 < e.dur)
    this.vision.update(dt)
  }

  spawnProjectile(p: Omit<Projectile, 'id' | 'traveled' | 'dead' | 'anyHit' | 'born' | 'hitIds'> & { hitIds?: Set<string> }) {
    const pr: Projectile = { ...p, id: nextLocalId(), traveled: 0, dead: false, anyHit: false, born: this.now, hitIds: p.hitIds ?? new Set() }
    this.projectiles.push(pr)
    return pr
  }

  private projScratch: Unit[] = []
  private updateProjectiles(dt: number) {
    if (!this.projectiles.length) return
    for (const p of this.projectiles) {
      if (p.dead) continue
      if (p.homing) {
        const t = p.homing
        const tx = t.x, tz = t.z
        const d = dist(p.x, p.z, tx, tz)
        const step = p.speed * dt
        if (d <= step + t.radius * 0.5 || t.dead && d <= step) {
          p.x = tx; p.z = tz
          p.dead = true
          if (!t.dead || p.auth) {
            if (p.auth && !t.dead) p.onHit?.(t, p)
            p.anyHit = true
          }
          p.onEnd?.(p, true)
          continue
        }
        if (t.dead && !t.local && this.now - t.deadAt > 0.5) { p.dead = true; continue }
        p.dx = (tx - p.x) / d; p.dz = (tz - p.z) / d
        p.x += p.dx * step; p.z += p.dz * step
        continue
      }
      const step = p.speed * dt
      const nx = p.x + p.dx * step, nz = p.z + p.dz * step
      // swept collision
      const cand = this.near((p.x + nx) / 2, (p.z + nz) / 2, step / 2 + p.width + 1, this.projScratch)
      let best: Unit | null = null, bestT = Infinity
      for (const u of cand) {
        if (p.pierce <= 0) break
        if (u.dead || p.hitIds.has(u.id) || !p.filter(u)) continue
        // segment-circle intersection param
        const rr = p.width + u.radius
        const fx = p.x - u.x, fz = p.z - u.z
        const a = step * step
        const b = 2 * (fx * p.dx * step + fz * p.dz * step)
        const c = fx * fx + fz * fz - rr * rr
        let t: number
        if (c <= 0) t = 0
        else {
          const disc = b * b - 4 * a * c
          if (disc < 0) continue
          t = (-b - Math.sqrt(disc)) / (2 * a)
          if (t < 0 || t > 1) continue
        }
        if (p.pierce === 1) { if (t < bestT) { bestT = t; best = u } }
        else {
          p.hitIds.add(u.id)
          p.pierce--
          p.anyHit = true
          if (p.auth) p.onHit?.(u, p)
          else this.fx({ kind: 'hitspark', x: u.x, z: u.z, r: 0.8, color: p.vis.color, dur: 0.3 })
        }
      }
      if (best) {
        p.hitIds.add(best.id)
        p.pierce--
        p.anyHit = true
        p.x += p.dx * step * bestT; p.z += p.dz * step * bestT
        p.traveled += step * bestT
        if (p.auth) p.onHit?.(best, p)
        else this.fx({ kind: 'hitspark', x: best.x, z: best.z, r: 0.8, color: p.vis.color, dur: 0.3 })
        if (p.pierce <= 0) { p.dead = true; p.onEnd?.(p, true); continue }
      } else {
        p.x = nx; p.z = nz
        p.traveled += step
      }
      if (p.traveled >= p.maxDist) { p.dead = true; p.onEnd?.(p, p.anyHit) }
    }
    this.projectiles = this.projectiles.filter(p => !p.dead)
  }

  /** ids of alive champions of a team */
  teamChamps(team: Team) {
    return this.champs.filter(c => c.team === team)
  }

  // current unit vision radius
  sightOf(u: Unit) {
    switch (u.kind) {
      case 'champ': return VISION.champ
      case 'minion': return VISION.minion
      case 'tower': return VISION.tower
      case 'ward': return VISION.ward
      case 'nexus': return VISION.nexus
      case 'inhib': return VISION.inhib
      default: return 0
    }
  }
}
