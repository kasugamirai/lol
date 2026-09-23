import { Unit } from './unit'
import type { World } from './world'
import { LaneId, MonsterType, CampDef } from './mapdef'
import { MINIONS, MinionType, MONSTERS, NpcDef, TOWER_RANGE, TOWER_AS, TOWER_PROJ, WARD } from './data/units'
import { F, Team } from './types'
import { dealDamage, tickBuffs } from './combat'
import { P2, angleTo, closestS, dist, dist2, pointAlong, polylineLength, turnToward } from '../util/math'

const scratch: Unit[] = []

function steerMove(w: World, u: Unit, tx: number, tz: number, speed: number, dt: number, sep = true) {
  let dx = tx - u.x, dz = tz - u.z
  const d = Math.hypot(dx, dz)
  if (d < 0.05) return
  dx /= d; dz /= d
  let vx = dx * speed, vz = dz * speed
  if (sep) {
    for (const o of w.near(u.x, u.z, u.radius + 1.2, scratch)) {
      if (o === u || o.kind === 'ward') continue
      const rr = u.radius + o.radius + (o.isStructure ? 0.3 : 0.05)
      const ox = u.x - o.x, oz = u.z - o.z
      const od = Math.hypot(ox, oz)
      if (od >= rr || od < 1e-4) continue
      const push = (rr - od) / rr
      const k = o.isStructure ? 9 : o.isChamp ? 2.5 : 4
      vx += (ox / od) * push * speed * k * 0.5
      vz += (oz / od) * push * speed * k * 0.5
    }
  }
  const vl = Math.hypot(vx, vz)
  const maxV = speed * 1.15
  if (vl > maxV) { vx = (vx / vl) * maxV; vz = (vz / vl) * maxV }
  const step = Math.min(1, d / Math.max(0.001, speed * dt))
  let nx = u.x + vx * dt * step, nz = u.z + vz * dt * step
  const g = w.grid
  if (!g.isWalkable(nx, nz)) {
    if (g.isWalkable(nx, u.z)) nz = u.z
    else if (g.isWalkable(u.x, nz)) nx = u.x
    else { nx = u.x; nz = u.z }
  }
  u.x = nx; u.z = nz
  u.facing = turnToward(u.facing, Math.atan2(dx, dz), dt * 12)
  u.moving = true
}

function inRange(a: Unit, t: Unit, range: number) {
  return dist(a.x, a.z, t.x, t.z) <= range + a.radius + t.radius
}

// ---------------------------------------------------------------- Minion
export class Minion extends Unit {
  def: NpcDef
  path: P2[]
  pathLen: number
  offset: number
  nextScan = 0
  scale = 1
  constructor(id: string, public mt: MinionType, team: Team, public lane: LaneId, lanePts: P2[], x: number, z: number, wave: number) {
    const def = MINIONS[mt]
    super(id, 'minion', mt, team, x, z, def.radius)
    this.def = def
    this.path = team === 0 ? lanePts : [...lanePts].reverse()
    this.pathLen = polylineLength(this.path)
    this.offset = (Math.random() - 0.5) * 3
    this.scale = 1 + 0.018 * wave
    this.stats.maxHp = Math.round(def.hp * this.scale)
    this.hp = this.stats.maxHp
    this.stats.ad = def.ad * (1 + 0.016 * wave)
    this.stats.armor = def.armor
    this.stats.mr = def.mr
    this.stats.as = def.as
    this.stats.range = def.range
    this.stats.ms = def.ms
    this.height = def.height
    this.bountyGold = def.gold
    this.bountyXp = def.xp
    this.name = def.name
  }

  update(w: World, dt: number) {
    if (this.dead) return
    if (tickBuffs(w, this, dt)) return
    this.fl = this.computeFlags()
    this.moving = false
    if (!this.canAttack()) { this.windup = 0; this.windupTarget = null; return }
    if (this.windup > 0) {
      this.windup -= dt
      if (this.windup <= 0) this.fire(w)
      return
    }
    this.atkCd -= dt
    let t = w.unit(this.targetId)
    if (!this.valid(w, t) || w.now >= this.nextScan) {
      this.nextScan = w.now + 0.35
      const nt = this.pick(w, t)
      if (nt !== t) { t = nt; this.targetId = t?.id ?? null }
    }
    if (t && this.valid(w, t)) {
      if (inRange(this, t, this.def.range)) {
        this.facing = turnToward(this.facing, angleTo(this.x, this.z, t.x, t.z), dt * 12)
        if (this.atkCd <= 0) {
          this.windup = this.def.windup
          this.windupTarget = t
          this.atkCd = 1 / this.def.as
          this.atkSeq++
          this.animAtk = w.now
        }
      } else if (this.canMove()) steerMove(w, this, t.x, t.z, this.moveSpeed(), dt)
      return
    }
    this.targetId = null
    if (this.canMove()) {
      const s = closestS(this.path, this.x, this.z)
      if (s >= this.pathLen - 0.5) return
      const [ax, az] = pointAlong(this.path, Math.min(this.pathLen, s + 4))
      const [bx, bz] = pointAlong(this.path, Math.min(this.pathLen, s + 4.5))
      let px = -(bz - az), pz = bx - ax
      const pl = Math.hypot(px, pz) || 1
      px /= pl; pz /= pl
      steerMove(w, this, ax + px * this.offset, az + pz * this.offset, this.moveSpeed(), dt)
    }
  }

  valid(w: World, t: Unit | null): t is Unit {
    if (!t || t.dead || t.team === this.team || t.team === 2 || t.kind === 'ward') return false
    if (!t.targetable()) return false
    if (!w.canSee(this.team, t)) return false
    if (t.isStructure && w.isProtected(t)) return false
    return dist(this.x, this.z, t.x, t.z) < 11
  }

  private pick(w: World, cur: Unit | null): Unit | null {
    const near = w.near(this.x, this.z, 7.5, scratch)
    // call for help: enemy champion attacking an allied champion nearby
    for (const u of near) {
      if (u.isChamp && u.team !== this.team && !u.dead && w.now - u.lastAttackedChamp < 1.5 && this.valid(w, u)) {
        const victim = w.unit(u.lastAttackedChampTarget)
        if (victim && victim.team === this.team && dist(victim.x, victim.z, this.x, this.z) < 9) return u
      }
    }
    if (cur && this.valid(w, cur) && inRange(this, cur, this.def.range + 0.5)) return cur
    let best: Unit | null = null, bd = Infinity
    for (const pass of [0, 1, 2]) {
      for (const u of near) {
        if (!this.valid(w, u)) continue
        const ok = pass === 0 ? u.kind === 'minion' : pass === 1 ? u.isChamp : u.isStructure
        if (!ok) continue
        const d = dist2(this.x, this.z, u.x, u.z)
        if (d < bd) { bd = d; best = u }
      }
      if (best) return best
    }
    // structures further away along the lane
    for (const s of [...w.towers, ...w.structs]) {
      if (s.team === this.team || s.dead || w.isProtected(s)) continue
      if (dist(this.x, this.z, s.x, s.z) < 8 + s.radius) return s
    }
    return null
  }

  private fire(w: World) {
    const t = this.windupTarget
    this.windupTarget = null
    if (!t || t.dead) return
    if (this.def.proj > 0) {
      w.spawnProjectile({
        srcId: this.id, src: this, team: this.team, x: this.x, z: this.z, y: 1, dx: 0, dz: 0,
        speed: this.def.proj, homing: t, maxDist: 999, width: 0.2, pierce: 1, auth: true,
        vis: { kind: this.mt === 'siege' ? 'cannon' : 'orb', color: this.team === 0 ? 0x6ab0ff : 0xff6a6a, size: this.mt === 'siege' ? 0.4 : 0.22 },
        filter: () => false,
        onHit: tt => dealDamage(w, this, tt, { p: this.stats.ad, aa: true }),
      })
    } else dealDamage(w, this, t, { p: this.stats.ad, aa: true })
  }
}

// ---------------------------------------------------------------- Tower logic
export function towerUpdate(w: World, u: Unit, dt: number, st: { chain: number; chainTarget: string; nextScan: number }) {
  if (u.dead) return
  u.atkCd -= dt
  let t = w.unit(u.targetId)
  const valid = (x: Unit | null): x is Unit =>
    !!x && !x.dead && x.team !== u.team && x.team !== 2 && x.kind !== 'ward' && x.targetable() && !x.has(F.STEALTH) &&
    dist(u.x, u.z, x.x, x.z) <= TOWER_RANGE + x.radius
  if (w.now >= st.nextScan) {
    st.nextScan = w.now + 0.25
    const near = w.near(u.x, u.z, TOWER_RANGE + 1, scratch)
    // aggro: enemy champion attacking allied champion within range
    let aggro: Unit | null = null
    for (const x of near) {
      if (!x.isChamp || !valid(x)) continue
      if (w.now - x.lastAttackedChamp < 1.2) {
        const victim = w.unit(x.lastAttackedChampTarget)
        if (victim && victim.team === u.team && dist(victim.x, victim.z, u.x, u.z) <= TOWER_RANGE + 1) { aggro = x; break }
      }
    }
    if (aggro) t = aggro
    else if (!valid(t)) {
      t = null
      let bd = Infinity
      for (const pass of [0, 1]) {
        for (const x of near) {
          if (!valid(x)) continue
          if (pass === 0 ? x.kind !== 'minion' : !(x.isChamp || x.kind === 'monster')) continue
          const d = dist2(u.x, u.z, x.x, x.z)
          if (d < bd) { bd = d; t = x }
        }
        if (t) break
      }
    }
    u.targetId = t?.id ?? null
  }
  if (!valid(t)) { u.targetId = null; return }
  if (u.atkCd <= 0) {
    u.atkCd = 1 / TOWER_AS
    u.atkSeq++
    u.animAtk = w.now
    const target = t
    if (target.isChamp) {
      if (st.chainTarget === target.id) st.chain = Math.min(3, st.chain + 1)
      else { st.chain = 0; st.chainTarget = target.id }
    } else { st.chain = 0; st.chainTarget = '' }
    const mult = 1 + 0.4 * st.chain
    w.spawnProjectile({
      srcId: u.id, src: u, team: u.team, x: u.x, z: u.z, y: 6.2, dx: 0, dz: 0,
      speed: TOWER_PROJ, homing: target, maxDist: 999, width: 0.3, pierce: 1, auth: true,
      vis: { kind: 'tower', color: u.team === 0 ? 0x7ac0ff : 0xff7a6a, size: 0.55, trail: true },
      filter: () => false,
      onHit: tt => {
        if (tt.kind === 'minion') {
          const pct: Record<string, number> = { melee: 0.45, caster: 0.7, siege: 0.14, super: 0.07 }
          dealDamage(w, u, tt, { t: tt.maxHp * (pct[tt.type] ?? 0.3), aa: true })
        } else dealDamage(w, u, tt, { p: u.stats.ad * mult, aa: true })
        w.hooks.sound?.('towerhit', tt.x, tt.z)
      },
    })
    w.hooks.sound?.('tower', u.x, u.z)
  }
}

// ---------------------------------------------------------------- Monster
export class Monster extends Unit {
  def: NpcDef
  homeX: number
  homeZ: number
  homeFace: number
  aggroId: string | null = null
  resetting = false
  lastEngaged = 0
  leash: number
  constructor(id: string, public mt: MonsterType, public camp: string, x: number, z: number, face: number, gameTime: number, epic: boolean) {
    const def = MONSTERS[mt]
    super(id, 'monster', mt, 2, x, z, def.radius)
    this.def = def
    this.homeX = x; this.homeZ = z; this.homeFace = face
    this.facing = face
    const sc = 1 + (gameTime / 60) * 0.035
    this.stats.maxHp = Math.round(def.hp * sc)
    this.hp = this.stats.maxHp
    this.stats.ad = def.ad * sc
    this.stats.armor = def.armor
    this.stats.mr = def.mr
    this.stats.as = def.as
    this.stats.ms = def.ms
    this.height = def.height
    this.bountyGold = def.gold
    this.bountyXp = def.xp
    this.name = def.name
    this.leash = epic ? 16 : 10
  }

  update(w: World, dt: number) {
    if (this.dead) return
    if (tickBuffs(w, this, dt)) return
    this.fl = this.computeFlags(this.resetting ? F.RESET : 0)
    this.moving = false
    const homeD = dist(this.x, this.z, this.homeX, this.homeZ)
    if (this.resetting) {
      this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.25 * dt)
      if (homeD < 0.5) {
        this.resetting = false
        this.hp = this.maxHp
        this.damagers.clear()
      } else steerMove(w, this, this.homeX, this.homeZ, Math.max(4, this.def.ms) * 1.6, dt, false)
      return
    }
    if (!this.canAttack()) { this.windup = 0; return }
    if (this.windup > 0) {
      this.windup -= dt
      if (this.windup <= 0) this.fire(w)
      return
    }
    this.atkCd -= dt
    const t = w.unit(this.aggroId)
    if (t && (t.dead || !t.targetable() || dist(this.homeX, this.homeZ, t.x, t.z) > this.leash + 4 || homeD > this.leash || w.now - this.lastEngaged > 7)) {
      this.startReset(w)
      return
    }
    if (!t) {
      if (homeD > 0.4) steerMove(w, this, this.homeX, this.homeZ, this.def.ms, dt, false)
      else this.facing = turnToward(this.facing, this.homeFace, dt * 3)
      if (this.hp < this.maxHp && w.now - this.lastDamaged > 4) this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.05 * dt)
      return
    }
    const range = this.def.range
    if (inRange(this, t, range)) {
      this.facing = turnToward(this.facing, angleTo(this.x, this.z, t.x, t.z), dt * 8)
      if (this.atkCd <= 0) {
        this.windup = this.def.windup
        this.windupTarget = t
        this.atkCd = 1 / this.def.as
        this.atkSeq++
        this.animAtk = w.now
        this.targetId = t.id
      }
    } else if (this.def.ms > 0 && this.canMove()) steerMove(w, this, t.x, t.z, this.moveSpeed(), dt)
  }

  startReset(w: World) {
    this.resetting = true
    this.aggroId = null
    this.targetId = null
    this.buffs = []
    this.windup = 0
  }

  aggro(w: World, src: Unit | null) {
    if (!src || this.resetting || src.team === 2) return
    if (!this.aggroId || !w.unit(this.aggroId) || w.unit(this.aggroId)!.dead) this.aggroId = src.id
    this.lastEngaged = w.now
  }

  private fire(w: World) {
    const t = this.windupTarget
    this.windupTarget = null
    if (!t || t.dead) return
    this.lastEngaged = w.now
    if (this.def.proj > 0) {
      w.spawnProjectile({
        srcId: this.id, src: this, team: 2, x: this.x, z: this.z, y: this.height * 0.6, dx: 0, dz: 0,
        speed: this.def.proj, homing: t, maxDist: 999, width: 0.3, pierce: 1, auth: true,
        vis: { kind: this.mt === 'dragon' ? 'breath' : 'spit', color: this.mt === 'dragon' ? 0xff7a2a : this.mt === 'baron' ? 0xb05aff : 0x8aff5a, size: this.mt === 'gromp' ? 0.35 : 0.8 },
        filter: () => false,
        onHit: tt => dealDamage(w, this, tt, { p: this.stats.ad, aa: true }),
      })
    } else {
      dealDamage(w, this, t, { p: this.stats.ad, aa: true })
      w.fx({ kind: 'slash', x: t.x, z: t.z, r: 1.2, dir: this.facing, color: 0xffffff, dur: 0.25 })
    }
  }
}

// ---------------------------------------------------------------- Ward
export class Ward extends Unit {
  expires: number
  constructor(id: string, team: Team, x: number, z: number, now: number) {
    super(id, 'ward', 'ward', team, x, z, WARD.radius)
    this.stats.maxHp = WARD.hp
    this.hp = WARD.hp
    this.expires = now + WARD.dur
    this.height = 1.2
    this.name = '守卫'
    this.bountyGold = 30
  }
}

export function campCenter(c: CampDef): P2 { return [c.x, c.z] }
