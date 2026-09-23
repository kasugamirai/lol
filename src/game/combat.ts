import type { World } from './world'
import { Unit } from './unit'
import { Champion } from './champion'
import { CCSpec, F, HitPayload, NetEvent } from './types'
import { champBounty } from './data/units'

export function mitigate(u: Unit, h: HitPayload) {
  const s = u.stats
  let phys = h.p ?? 0, mag = h.m ?? 0, tru = h.t ?? 0
  if (h.mh) mag += u.maxHp * h.mh
  if (h.ms) tru += Math.max(0, u.maxHp - u.hp) * h.ms
  const armor = Math.max(0, s.armor * (1 - (h.apen ?? 0)))
  const mr = Math.max(0, s.mr - (h.mpen ?? 0))
  phys *= 100 / (100 + armor)
  mag *= 100 / (100 + mr)
  let total = phys + mag + tru
  if (h.aa && u instanceof Champion && u.hasItem('plated_boots')) total *= 0.88
  total *= 1 - u.damageReduction()
  return { total, phys, mag, tru }
}

/** Owner-side application of a hit */
export function applyHit(w: World, u: Unit, h: HitPayload) {
  if (u.dead) return
  if (u.fl & (F.INVULN | F.STASIS)) return
  if (u.isStructure && w.isProtected(u)) return
  const src = w.unit(h.src)
  let { total } = mitigate(u, h)
  if (u instanceof Champion && src && src.kind === 'monster' && u.spells.includes('smite')) total *= 0.65
  if (u.kind === 'ward') {
    if (!h.aa) return
    total = 1
  }
  if (u.isStructure) {
    // structures only take basic attack damage from champions & minions
    if (!h.aa) return
  }
  // shields absorb
  if (total > 0) {
    const shields = u.buffs.filter(b => b.kind === 'shield' && b.value > 0).sort((a, b) => a.until - b.until)
    for (const s of shields) {
      const a = Math.min(s.value, total)
      s.value -= a
      total -= a
      if (total <= 0) break
    }
    u.buffs = u.buffs.filter(b => b.kind !== 'shield' || b.value > 0.5)
  }
  u.hp -= total
  u.lastDamaged = w.now
  if (src) u.damagers.set(src.id, w.now)
  if (u === w.me && total >= 1) {
    w.float(u.x, u.z, `-${Math.round(total)}`, '#ff5a5a', 15, 2.6)
  }
  if (u instanceof Champion) u.onDamaged(src, h)
  else if (w.isHost) w.host.onDamaged(u, src)

  if (h.cc) for (const cc of h.cc) applyCC(w, u, cc, h.src)

  if (u.hp <= 0) killUnit(w, u, src ? src.id : '', h.sk)
}

export function applyCC(w: World, u: Unit, cc: CCSpec, src: string) {
  if (u.isStructure || u.dead) return
  if (u.kind === 'monster' && (u.type === 'baron' || u.type === 'dragon') && cc.k !== 'slow' && cc.k !== 'burn') return
  switch (cc.k) {
    case 'stun': case 'root': case 'silence': case 'knockup':
      u.addBuff(w.now, { kind: cc.k, dur: cc.d }, src)
      if (u instanceof Champion && (cc.k === 'stun' || cc.k === 'knockup')) u.interrupt()
      if (u.kind !== 'champ' && (cc.k === 'stun' || cc.k === 'knockup')) u.windup = 0
      break
    case 'slow':
      u.addBuff(w.now, { kind: 'slow', dur: cc.d, value: cc.a ?? 0.3, key: 'slow:' + src }, src)
      break
    case 'burn': {
      const ticks = Math.max(1, Math.round(cc.d / 0.5))
      u.addBuff(w.now, { kind: 'burn', dur: cc.d, value: (cc.a ?? 20) / ticks, key: 'burn:' + src }, src)
      break
    }
    case 'knockback': {
      if (cc.x === undefined || cc.z === undefined) break
      const dx = u.x - cc.x, dz = u.z - cc.z
      const l = Math.hypot(dx, dz) || 1
      const [nx, nz] = w.grid.castWalkable(u.x, u.z, u.x + (dx / l) * (cc.a ?? 2), u.z + (dz / l) * (cc.a ?? 2))
      u.x = nx; u.z = nz
      u.addBuff(w.now, { kind: 'stun', dur: cc.d }, src)
      break
    }
  }
}

export function killUnit(w: World, u: Unit, killerId: string, sk?: string) {
  if (u.dead) return
  u.dead = true
  u.hp = 0
  u.deadAt = w.now
  u.windup = 0
  const assists: string[] = []
  for (const [id, t] of u.damagers) {
    if (id === killerId || w.now - t > 10) continue
    const a = w.unit(id)
    if (a && a.isChamp && a.team !== u.team) assists.push(id)
  }
  const ev: NetEvent = { e: 'death', id: u.id, k: killerId, as: assists, x: +u.x.toFixed(1), z: +u.z.toFixed(1), uk: u.kind, ut: u.type, tm: u.team }
  if (u instanceof Champion && ev.e === 'death') {
    ev.lv = u.level
    ev.b = champBounty(u.streak, u.deathStreak)
    const killer = w.unit(killerId)
    if (!w.firstBlood && killer && killer.isChamp && killer.team !== u.team) ev.fb = 1
    if (sk) ev.sk = sk
    u.onDeath(killerId)
  } else if (w.isHost) {
    w.host.onDeath(u, killerId)
  }
  w.emit(ev)
  w.handleEvent(ev, false)
}

export interface DmgSpec {
  p?: number
  m?: number
  t?: number
  cc?: CCSpec[]
  aa?: boolean
  cr?: boolean
  sk?: string
  mh?: number
  ms?: number
}

export function estimate(tgt: Unit, h: HitPayload) {
  return mitigate(tgt, h).total
}

/** attacker-side: build a hit and send it to the target's owner. Returns estimated damage */
export function dealDamage(w: World, src: Unit, tgt: Unit, d: DmgSpec): number {
  if (tgt.dead) return 0
  const hit: HitPayload = { tgt: tgt.id, src: src.id }
  if (d.p) hit.p = Math.round(d.p * 10) / 10
  if (d.m) hit.m = Math.round(d.m * 10) / 10
  if (d.t) hit.t = Math.round(d.t * 10) / 10
  if (d.cc) hit.cc = d.cc
  if (d.aa) hit.aa = 1
  if (d.cr) hit.cr = 1
  if (d.sk) hit.sk = d.sk
  if (d.mh) hit.mh = d.mh
  if (d.ms) hit.ms = d.ms
  if (src.stats.apen) hit.apen = src.stats.apen
  if (src.stats.mpen) hit.mpen = src.stats.mpen
  // dragon soul: damage amp
  if (src instanceof Champion) {
    const dr = src.getBuff('dragon')
    if (dr) {
      const k = 1 + 0.05 * dr.value
      if (hit.p) hit.p *= k
      if (hit.m) hit.m *= k
    }
  }
  if (src instanceof Champion && tgt.kind === 'monster' && src.spells.includes('smite')) {
    if (hit.p) hit.p *= 1.35
    if (hit.m) hit.m *= 1.35
  }
  const est = tgt.isStructure && !d.aa ? 0 : estimate(tgt, hit)
  if (tgt.isStructure && !d.aa) return 0
  w.sendHit(tgt, hit)
  if (src === w.me && tgt !== w.me && est >= 1) {
    const col = d.t && !d.p && !d.m ? '#ffffff' : d.m && !d.p ? '#b98bff' : d.cr ? '#ff9a2a' : '#ffd9a0'
    w.float(tgt.x, tgt.z, d.cr ? `${Math.round(est)}!` : `${Math.round(est)}`, col, d.cr ? 22 : 16, tgt.height + 0.6)
  }
  if (src instanceof Champion) {
    if (d.aa && src.stats.ls > 0) w.healUnit(src, est * src.stats.ls, false)
    if (tgt.isChamp) src.dmgToChamps += est
  }
  return est
}

export function isEnemyTarget(src: Unit, u: Unit) {
  return u.team !== src.team && !u.dead && u.kind !== 'ward' && !u.isStructure && !(u.fl & (F.INVULN | F.STASIS))
}

/** owner-side per-frame buff processing (dots, regen, expiry). Returns true if the unit died. */
export function tickBuffs(w: World, u: Unit, dt: number): boolean {
  const now = w.now
  if (!u.buffs.length) return false
  for (const b of u.buffs) {
    if (b.kind === 'burn' && b.next !== undefined && now >= b.next) {
      b.next += 0.5
      const amt = b.value
      u.hp -= amt
      u.lastDamaged = now
      if (b.src) u.damagers.set(b.src, now)
      if (u === w.me) w.float(u.x, u.z, `-${Math.round(amt)}`, '#ff9a5a', 13, 2.4)
      if (u.hp <= 0) { killUnit(w, u, b.src ?? ''); return true }
    } else if (b.kind === 'regen') u.hp = Math.min(u.maxHp, u.hp + b.value * dt)
  }
  u.buffs = u.buffs.filter(b => b.until > now && !(b.kind === 'shield' && b.value <= 0.5))
  return false
}
