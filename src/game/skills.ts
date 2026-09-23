import type { World, ProjVis, Projectile } from './world'
import { INTERP_DELAY } from './world'
import { Unit } from './unit'
import { Champion } from './champion'
import { BuffSpec, CastKey, NetEvent } from './types'
import { dealDamage, DmgSpec, isEnemyTarget } from './combat'
import { angleTo, dist, segDist2, wrapAngle } from '../util/math'

export type Targeting = 'dir' | 'point' | 'unit' | 'self' | 'ally'
export interface Indicator { t: 'line' | 'circle' | 'cone' | 'none' | 'range'; w?: number; r?: number; a?: number }
export interface BotHint {
  use: 'poke' | 'engage' | 'finisher' | 'escape' | 'buff' | 'heal' | 'aoe' | 'global' | 'shield' | 'none'
  range?: number
}

export interface SkillDef {
  id: string
  name: string
  icon: string
  maxLv: number
  cost: number[]
  cd: number[]
  range: number
  target: Targeting
  unitTeam?: 'enemy' | 'ally' | 'any'
  champOnly?: boolean
  castTime: number
  ind: Indicator
  bot: BotHint
  desc: (lv: number, c: Champion) => string
  cast: (ctx: CastCtx) => void
  selfCast?: boolean
  noClamp?: boolean
}

export interface CastCtx {
  w: World
  c: Unit
  ch: Champion | null
  lvl: number
  x: number
  z: number
  ox: number
  oz: number
  dx: number
  dz: number
  target: Unit | null
  auth: boolean
  key: CastKey
  sid: string
}

export { SKILLS, registerSkill } from './skillreg'
import { SKILLS } from './skillreg'

export const lv = (arr: number[], l: number) => arr[Math.max(0, Math.min(arr.length - 1, l - 1))]

export function makeCtx(w: World, c: Unit, sid: string, key: CastKey, lvl: number, x: number, z: number, tid: string | undefined, auth: boolean, ox = c.x, oz = c.z): CastCtx {
  let dx = x - ox, dz = z - oz
  const l = Math.hypot(dx, dz)
  if (l < 1e-4) { dx = Math.sin(c.facing); dz = Math.cos(c.facing) } else { dx /= l; dz /= l }
  return { w, c, ch: c instanceof Champion ? c : null, lvl, x, z, ox, oz, dx, dz, target: w.unit(tid), auth, key, sid }
}

/** remote clients replay casts for visuals only */
export function runRemoteCast(w: World, u: Unit, ev: Extract<NetEvent, { e: 'cast' }>) {
  const def = SKILLS.get(ev.id)
  const delay = INTERP_DELAY / 1000
  w.after(delay, () => {
    u.animCast = w.now
    u.animCastKey = ev.k
  })
  if (!def) return
  w.after(delay + def.castTime, () => {
    const ctx = makeCtx(w, u, ev.id, ev.k, ev.l, ev.x, ev.z, ev.tid, false, ev.ox, ev.oz)
    try { def.cast(ctx) } catch (e) { console.warn('remote cast failed', ev.id, e) }
  })
}

// ------------------------------------------------------------------ helpers

export function enemyFilter(ctx: CastCtx, champsOnly = false) {
  return (u: Unit) => isEnemyTarget(ctx.c, u) && (!champsOnly || u.isChamp)
}

export function dmg(ctx: CastCtx, t: Unit, d: DmgSpec) {
  if (!ctx.auth) return 0
  return dealDamage(ctx.w, ctx.c, t, { sk: ctx.sid, ...d })
}

export function buffSelf(ctx: CastCtx, spec: BuffSpec) {
  if (ctx.c.local) ctx.c.addBuff(ctx.w.now, spec, ctx.c.id)
}

export function buffUnit(ctx: CastCtx, t: Unit, spec: BuffSpec) {
  if (!ctx.auth) return
  if (t.local) t.addBuff(ctx.w.now, spec, ctx.c.id)
  else ctx.w.emit({ e: 'buff', tgt: t.id, src: ctx.c.id, b: spec })
}

export function healTarget(ctx: CastCtx, t: Unit, amount: number) {
  ctx.w.fx({ kind: 'heal', x: t.x, z: t.z, r: 1.2, color: 0x7dff9a, dur: 0.9, follow: t })
  if (!ctx.auth) return
  if (t.local) ctx.w.healUnit(t, amount, true)
  else ctx.w.emit({ e: 'heal', tgt: t.id, src: ctx.c.id, a: Math.round(amount) })
}

export function enemiesInCircle(ctx: CastCtx, x: number, z: number, r: number, champsOnly = false) {
  const f = enemyFilter(ctx, champsOnly)
  return ctx.w.near(x, z, r, []).filter(f)
}
export function alliesInCircle(ctx: CastCtx, x: number, z: number, r: number, champsOnly = true) {
  return ctx.w.near(x, z, r, []).filter(u => u.team === ctx.c.team && !u.dead && (!champsOnly || u.isChamp))
}
export function enemiesInLine(ctx: CastCtx, x0: number, z0: number, dx: number, dz: number, len: number, width: number, champsOnly = false) {
  const x1 = x0 + dx * len, z1 = z0 + dz * len
  const f = enemyFilter(ctx, champsOnly)
  return ctx.w.near((x0 + x1) / 2, (z0 + z1) / 2, len / 2 + width, []).filter(u => f(u) && segDist2(u.x, u.z, x0, z0, x1, z1) <= (width + u.radius) ** 2)
}
export function enemiesInCone(ctx: CastCtx, range: number, halfAngle: number) {
  const f = enemyFilter(ctx)
  const face = Math.atan2(ctx.dx, ctx.dz)
  return ctx.w.near(ctx.ox, ctx.oz, range, []).filter(u => {
    if (!f(u)) return false
    if (dist(u.x, u.z, ctx.ox, ctx.oz) < u.radius + 0.5) return true
    return Math.abs(wrapAngle(angleTo(ctx.ox, ctx.oz, u.x, u.z) - face)) <= halfAngle
  })
}

export function skillshot(ctx: CastCtx, o: {
  range: number
  speed: number
  width: number
  vis: ProjVis
  dx?: number
  dz?: number
  pierce?: number
  champsOnly?: boolean
  hitIds?: Set<string>
  onHit?: (t: Unit, p: Projectile) => void
  onEnd?: (p: Projectile, hit: boolean) => void
}) {
  const dx = o.dx ?? ctx.dx, dz = o.dz ?? ctx.dz
  return ctx.w.spawnProjectile({
    srcId: ctx.c.id, src: ctx.c, team: ctx.c.team,
    x: ctx.ox + dx * 0.6, z: ctx.oz + dz * 0.6, y: 1.1,
    dx, dz, speed: o.speed, homing: null, maxDist: o.range, width: o.width,
    pierce: o.pierce ?? 1, auth: ctx.auth, vis: o.vis,
    filter: enemyFilter(ctx, o.champsOnly), onHit: o.onHit, onEnd: o.onEnd, hitIds: o.hitIds,
  })
}

export function homing(ctx: CastCtx, target: Unit, o: { speed: number; vis: ProjVis; onHit: (t: Unit) => void }) {
  return ctx.w.spawnProjectile({
    srcId: ctx.c.id, src: ctx.c, team: ctx.c.team,
    x: ctx.ox, z: ctx.oz, y: 1.2, dx: 0, dz: 0, speed: o.speed, homing: target, maxDist: 999, width: 0.3,
    pierce: 1, auth: ctx.auth, vis: o.vis, filter: () => false, onHit: t => o.onHit(t),
  })
}

export function aoeCircle(ctx: CastCtx, o: {
  x: number; z: number; r: number; delay: number; color: number
  onHit: (t: Unit) => void
  burst?: 'burst' | 'nova' | 'explosion'
  champsOnly?: boolean
  noTelegraph?: boolean
}) {
  const w = ctx.w
  if (o.delay > 0 && !o.noTelegraph) w.fx({ kind: 'telegraph', x: o.x, z: o.z, r: o.r, color: o.color, dur: o.delay, team: ctx.c.team })
  const run = () => {
    w.fx({ kind: o.burst ?? 'burst', x: o.x, z: o.z, r: o.r, color: o.color, dur: 0.5 })
    w.hooks.sound?.('boom', o.x, o.z)
    if (!ctx.auth) return
    for (const u of enemiesInCircle(ctx, o.x, o.z, o.r, o.champsOnly)) o.onHit(u)
  }
  if (o.delay > 0) w.after(o.delay, run)
  else run()
}

export function aoeLine(ctx: CastCtx, o: {
  len: number; width: number; delay: number; color: number; kind?: 'beam' | 'line'
  onHit: (t: Unit) => void
  x0?: number; z0?: number
}) {
  const w = ctx.w
  const x0 = o.x0 ?? ctx.ox, z0 = o.z0 ?? ctx.oz
  const dir = Math.atan2(ctx.dx, ctx.dz)
  if (o.delay > 0) w.fx({ kind: 'line', x: x0, z: z0, r: o.width, len: o.len, dir, color: o.color, dur: o.delay, team: ctx.c.team })
  const run = () => {
    w.fx({ kind: o.kind ?? 'beam', x: x0, z: z0, r: o.width, len: o.len, dir, color: o.color, dur: o.kind === 'line' ? 0.25 : 0.6 })
    if (!ctx.auth) return
    for (const u of enemiesInLine(ctx, x0, z0, ctx.dx, ctx.dz, o.len, o.width)) o.onHit(u)
  }
  if (o.delay > 0) w.after(o.delay, run)
  else run()
}

export function aoeCone(ctx: CastCtx, o: { range: number; half: number; color: number; onHit: (t: Unit) => void }) {
  ctx.w.fx({ kind: 'cone', x: ctx.ox, z: ctx.oz, r: o.range, dir: Math.atan2(ctx.dx, ctx.dz), color: o.color, dur: 0.35, data: { half: o.half } })
  if (!ctx.auth) return
  for (const u of enemiesInCone(ctx, o.range, o.half)) o.onHit(u)
}

export function zone(ctx: CastCtx, o: { x: number; z: number; r: number; dur: number; tick: number; color: number; onTick: (t: Unit) => void }) {
  const w = ctx.w
  w.fx({ kind: 'zone', x: o.x, z: o.z, r: o.r, color: o.color, dur: o.dur })
  if (!ctx.auth) return
  const n = Math.round(o.dur / o.tick)
  for (let i = 1; i <= n; i++) {
    w.after(i * o.tick, () => {
      for (const u of enemiesInCircle(ctx, o.x, o.z, o.r)) o.onTick(u)
    })
  }
}

export function dashTo(ctx: CastCtx, o: {
  x: number; z: number; speed: number; width?: number; color: number
  onPass?: (t: Unit) => void
  onEnd?: () => void
  unstoppable?: boolean
  champsOnly?: boolean
}) {
  const c = ctx.c
  const [ex, ez] = ctx.w.grid.castWalkable(ctx.ox, ctx.oz, o.x, o.z)
  const d = dist(ctx.ox, ctx.oz, ex, ez)
  const dur = d / o.speed
  ctx.w.fx({ kind: 'trail', x: ctx.ox, z: ctx.oz, r: 0.8, color: o.color, dur: dur + 0.25, follow: c })
  if (c instanceof Champion && c.local) {
    c.startDash({ tx: ex, tz: ez, speed: o.speed, width: o.width ?? 1, onPass: o.onPass, onEnd: o.onEnd, hit: new Set(), unstoppable: !!o.unstoppable, filter: enemyFilter(ctx, o.champsOnly) })
  } else if (!ctx.auth) {
    // remote: position comes from snapshots; run the end effect for visuals
    if (o.onEnd) ctx.w.after(dur, () => o.onEnd!())
  }
}

export function blinkTo(ctx: CastCtx, x: number, z: number, color = 0xfff2a0) {
  const w = ctx.w
  let p = w.grid.isWalkable(x, z) ? [x, z] as [number, number] : w.grid.nearestWalkable(x, z, 6)
  if (!p) p = w.grid.castWalkable(ctx.ox, ctx.oz, x, z)
  w.fx({ kind: 'flash', x: ctx.ox, z: ctx.oz, r: 1.2, color, dur: 0.5 })
  w.fx({ kind: 'flash', x: p[0], z: p[1], r: 1.2, color, dur: 0.5 })
  w.hooks.sound?.('blink', p[0], p[1])
  if (ctx.c.local) {
    ctx.c.x = p[0]; ctx.c.z = p[1]
    ctx.c.tp++
    if (ctx.c instanceof Champion) ctx.c.clearPath()
  }
  return p
}

export function clampToRange(ox: number, oz: number, x: number, z: number, range: number): [number, number] {
  const d = dist(ox, oz, x, z)
  if (d <= range || d < 1e-5) return [x, z]
  return [ox + ((x - ox) / d) * range, oz + ((z - oz) / d) * range]
}

export const ADR = (c: Unit) => c.stats.ad
export const APR = (c: Unit) => c.stats.ap
export const r1 = (n: number) => Math.round(n)
