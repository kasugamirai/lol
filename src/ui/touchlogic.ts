// Pure touch-control logic (no DOM): constants, the touch HUD layout table, joystick look-ahead,
// attack / skill target selection and smart-cast / drag-aim plans. Used by touch.ts and scripts/touchtest.ts.
import type { World } from '../game/world'
import type { Unit } from '../game/unit'
import type { SkillDef } from '../game/skills'
import type { CastKey, HitPayload } from '../game/types'
import { castTargetOk, type Champion } from '../game/champion'
import { mitigate } from '../game/combat'
import { angleTo, clamp, dist, wrapAngle } from '../util/math'

const DEG = Math.PI / 180

// ------------------------------------------------------------------ constants
// pixel values are CSS px at UI scale s = 1 (multiply by s at use sites); angles in radians unless noted

// joystick
export const JR = 58 // ring radius
export const KNOB_R = 26
export const JOY_DEAD = 10 // held but neutral below this
export const JOY_FOLLOW = 72 // dynamic mode: the base follows the finger beyond this
export const JOY_EDGE = 20 // zone starts this far from the left safe edge
export const JOY_ZONE_X = 0.42 // zone: x < 0.42·vw
export const JOY_ZONE_Y = 0.30 // zone: y > 0.30·vh
export const JOY_REISSUE_MS = 100 // keep-alive re-issue of the move order
export const JOY_REISSUE_ANG = 8 * DEG // re-issue at once when the direction turns more than this
export const JOY_MIN_GAP_MS = 33

// look-ahead (world units / seconds)
export const LOOK_MIN = 2.2
export const LOOK_MAX = 4.0
export const LOOK_T = 0.6
export const WALL_STEP = 0.25
export const SLIDE_ANGLES = [0, 20, -20, 40, -40, 60, -60, 80, -80] // degrees
export const SLIDE_MIN_FREE = 0.75
export const CAST_YIELD_MS = 400

// attack
export const ATK_EVAL_MS = 100
export const ACQ_SLACK = { melee: 2.5, ranged: 1.2, tower: 3.0 }
export const KEEP_EXTRA = 1.0
export const LEASH_EXTRA = 2.0
export const TAP_PULSE_MS = 350
export const ATK_PROTECT_MS = 600

// skills
export const AIM_DEAD = 14
export const AIM_MAX = 110
export const CANCEL_R_HIT = 44
export const PRE_AIM_CD = 0.4 // s: may start aiming when the remaining cooldown is at most this
export const RETRY_MS = 400

// taps and presses
export const TAP_SLOP = 10
export const TAP_MS = 300
export const LONGPRESS_MS = 500
export const PICK_MIN_RAD = 26
export const MM_PING_MS = 450
export const MM_SLOP = 8
export const FOCUS_MAX = 15 // world units: a focused (tapped) unit is dropped beyond this

// camera: sin(pitch) of CAM_OFFSET (0, 27, 17.5) in render/renderer.ts
export const PITCH_SIN = 0.839

/** viewport width below which the 补刀/推塔 buttons hide and the item row caps at ITEMS.maxNarrow */
export const NARROW_W = 740

// ------------------------------------------------------------------ touch HUD layout
/** [dx, dy, diameter]: centre offset from the anchor A (screen px, +y down) at s = 1 */
export type TcSpot = [number, number, number]
export interface TcLayout {
  main: TcSpot; Q: TcSpot; W: TcSpot; E: TcSpot; R: TcSpot; D: TcSpot; F: TcSpot
  ward: TcSpot; minion: TcSpot; tower: TcSpot; recall: TcSpot; cancel: TcSpot
  /** active item row: first centre (dx, dy), centre step at s = 1, size; gap = intended unscaled flex gap */
  ITEMS: { dx: number; dy: number; step: number; size: number; max: number; maxNarrow: number; gap: number }
  /** skill level-up buttons: `out` px outward from the skill centre along `ang` (degrees, screen space: 180 = left, 270 = up) */
  LVLUP: { out: number; size: number; slop: number; ang: { Q: number; W: number; E: number; R: number } }
  /** anchor A (attack button centre): right = --sr + right·s, bottom = --sb + bottom·s */
  ANCHOR: { right: number; bottom: number }
}

export const TC_LAYOUT: TcLayout = {
  main: [0, 0, 80],
  Q: [-125, 0, 56],
  W: [-108, -62.5, 56],
  E: [-62.5, -108, 56],
  R: [0, -125, 56],
  D: [-183.5, -49, 44],
  F: [-141, -127, 44],
  ward: [-49, -183.5, 40],
  minion: [-70, 40, 38],
  tower: [46, -72, 38],
  recall: [-205, 38, 40],
  cancel: [-230, -255, 68], // clear of every aim disc: |cancel − skill| ≥ AIM_MAX + CANCEL_R_HIT
  ITEMS: { dx: -249, dy: 38, step: -42, size: 38, max: 6, maxNarrow: 3, gap: 4 },
  LVLUP: { out: 44, size: 28, slop: 6, ang: { Q: 180, W: 210, E: 240, R: 270 } },
  ANCHOR: { right: 66, bottom: 62 },
}

/** centre offset of a skill's level-up button from the anchor, at s = 1 */
export function tcLvlupPos(key: 'Q' | 'W' | 'E' | 'R'): [number, number] {
  const [dx, dy] = TC_LAYOUT[key], L = TC_LAYOUT.LVLUP, a = L.ang[key] * DEG
  return [dx + Math.cos(a) * L.out, dy + Math.sin(a) * L.out]
}

/** centre offset of the i-th active item slot from the anchor at scale s (sizes scale, the flex gap does not) */
export function tcItemPos(i: number, s = 1): [number, number] {
  const it = TC_LAYOUT.ITEMS
  return [s * it.dx - i * (s * it.size + it.gap), s * it.dy]
}

// ------------------------------------------------------------------ types
export type AtkMode = 'main' | 'minion' | 'tower'
export type AtkPri = 'lowhp' | 'near'
/** a resolved cast: target point, optional unit id (for dir/point it only marks the auto-aimed enemy;
 *  tryCast ignores it there), and reach = world distance the cast extends from me (0 for self) */
export interface CastPlan { x: number; z: number; tid?: string; reach: number }

const FLASH_ID = 'spell.flash'
const SMITE_ID = 'spell.smite'
const WARD_SMART_DIST = 1.5
const TIER = 1e7 // score tier separation

// ------------------------------------------------------------------ geometry
/** screen-space drag vector (px, +y down) → unit world direction (x, z) on the ground; null when zero.
 *  Screen up is world −z; vertical screen distances are foreshortened by the camera pitch. */
export function screenVecToWorldDir(sx: number, sy: number): [number, number] | null {
  const wx = sx, wz = sy / PITCH_SIN
  const l = Math.hypot(wx, wz)
  return l < 1e-6 ? null : [wx / l, wz / l]
}

/** unit vector of the champion's facing (convention: direction = (sin f, cos f)) */
export function facingDir(me: Champion): [number, number] {
  return [Math.sin(me.facing), Math.cos(me.facing)]
}

function unitFwd(me: Champion, fwd: [number, number]): [number, number] {
  const l = Math.hypot(fwd[0], fwd[1])
  return l > 1e-6 ? [fwd[0] / l, fwd[1] / l] : facingDir(me)
}

function along(me: Champion, ux: number, uz: number, d: number): CastPlan {
  return { x: me.x + ux * d, z: me.z + uz * d, reach: d }
}

/**
 * Joystick look-ahead with wall sliding. Returns a short walkable point in line of sight
 * (so cmdMove takes findPath's LOS fast path), or null when boxed in.
 */
export function joyTarget(w: World, me: Champion, ux: number, uz: number): [number, number] | null {
  const g = w.grid
  const L = clamp(me.moveSpeed() * LOOK_T, LOOK_MIN, LOOK_MAX)
  // off-grid after a dash or knockback: let findPath snap it
  if (!g.isWalkable(me.x, me.z)) return [me.x + ux * L, me.z + uz * L]
  const n = Math.ceil(L / WALL_STEP - 1e-9)
  // walkable length along a ray (sampled every WALL_STEP up to L, then confirmed with the grid LOS walk)
  const free = (dx: number, dz: number) => {
    let s = 0
    for (let k = 1; k <= n; k++) {
      const t = Math.min(L, k * WALL_STEP)
      if (!g.isWalkable(me.x + dx * t, me.z + dz * t)) break
      s = t
    }
    while (s > 0 && !g.los(me.x, me.z, me.x + dx * s, me.z + dz * s)) s = Math.max(0, s - WALL_STEP)
    return s
  }
  let best: [number, number] | null = null, bestScore = 0
  for (const deg of SLIDE_ANGLES) {
    const a = deg * DEG, c = Math.cos(a), sn = Math.sin(a)
    const dx = ux * c - uz * sn, dz = ux * sn + uz * c
    const s = free(dx, dz)
    if (deg === 0 && s >= L - 1e-6) return [me.x + dx * L, me.z + dz * L] // clear straight ahead
    const score = s * c // forward progress along the thumb's intent
    if (s >= SLIDE_MIN_FREE && score > bestScore + 1e-3) { bestScore = score; best = [me.x + dx * s, me.z + dz * s] }
  }
  return best
}

// ------------------------------------------------------------------ attack targeting
/** basic attack reach measured to the target's edge (edgeDist ≤ atkReach ⇔ me.inAtkRange(u)) */
export function atkReach(me: Champion): number {
  return me.stats.range + me.radius
}

/** centre distance minus the target radius */
export function edgeDist(me: Unit, u: Unit): number {
  return dist(me.x, me.z, u.x, u.z) - u.radius
}

/** damage of one plain basic attack (no crit, no on-hit), mitigated exactly like dealDamage → applyHit */
export function aaDamage(me: Champion, u: Unit): number {
  let p = me.stats.ad
  const dr = me.getBuff('dragon')
  if (dr) p *= 1 + 0.05 * dr.value
  if (u.kind === 'monster' && me.spells.includes('smite')) p *= 1.35
  const h: HitPayload = { tgt: u.id, src: me.id, p, aa: 1 }
  if (me.stats.apen) h.apen = me.stats.apen
  return mitigate(u, h).total
}

const isLane = (u: Unit) => u.kind === 'minion' || u.kind === 'monster'
const killable = (me: Champion, u: Unit) => u.hp <= aaDamage(me, u)

function fits(mode: AtkMode, u: Unit) {
  return mode === 'main' ? true : mode === 'minion' ? isLane(u) || u.kind === 'ward' : u.isStructure
}

/** preference class, lower is better */
function atkClass(mode: AtkMode, me: Champion, u: Unit): number {
  if (mode === 'tower') return 0
  const k = isLane(u) && killable(me, u)
  if (mode === 'main') return u.isChamp ? 0 : k ? 1 : isLane(u) ? 2 : u.kind === 'ward' ? 3 : 4
  return k ? 0 : isLane(u) ? 1 : 2
}

/** score inside a class, lower is better */
function atkInner(me: Champion, u: Unit, c: number, mode: AtkMode, pri: AtkPri): number {
  const e = edgeDist(me, u)
  const out = e > atkReach(me) ? 1000 : 0 // in range beats out of range
  if (u.isChamp) return out + (pri === 'lowhp' ? u.hp + u.shieldTotal() : e * 100)
  if ((mode === 'main' && c === 2) || (mode === 'minion' && c === 1)) return out + u.hp // lowest HP first: prepares last hits
  return out + e
}

/** attack button target: focus > class (champion > last hit > lane > ward > structure) > inner score, with stickiness */
export function pickAttackTarget(w: World, me: Champion, mode: AtkMode, cur: Unit | null,
  opts: { joy: boolean; pri: AtkPri; focus: Unit | null }): Unit | null {
  const reach = atkReach(me)
  const slack = mode === 'tower' ? ACQ_SLACK.tower : me.def.melee ? ACQ_SLACK.melee : ACQ_SLACK.ranged
  const R = opts.joy ? reach + 0.2 : reach + slack // while steering, never chase
  const ok = (u: Unit | null): u is Unit => !!u && me.validTarget(u) && fits(mode, u)
  const focus = opts.focus
  if (ok(focus) && edgeDist(me, focus) <= R + 2) return focus
  let best: Unit | null = null, bc = 9, bi = Infinity
  for (const u of w.near(me.x, me.z, R + 0.05)) {
    if (!ok(u) || edgeDist(me, u) > R) continue
    const c = atkClass(mode, me, u), i = atkInner(me, u, c, mode, opts.pri)
    if (c < bc || (c === bc && i < bi)) { bc = c; bi = i; best = u }
  }
  // stickiness: keep the current target unless the best one is in a strictly better class
  if (ok(cur) && edgeDist(me, cur) <= R + KEEP_EXTRA) {
    if (!best || best === cur) return cur
    // orb-walking never chases: a sticky target that drifted out of range loses to one in range
    if (opts.joy && edgeDist(me, cur) > reach && edgeDist(me, best) <= reach) return best
    const cc = atkClass(mode, me, cur)
    if (bc < cc) return best
    const champSwap = cur.isChamp && best.isChamp && killable(me, best) && !killable(me, cur)
    return champSwap ? best : cur
  }
  return best
}

/** smart dir/point casts: best enemy (not structure, not ward) within R of its edge; champions first by pri, else the nearest */
export function pickEnemyInRange(w: World, me: Champion, R: number, pri: AtkPri, champsOnly = false): Unit | null {
  let best: Unit | null = null, bs = Infinity
  for (const u of w.near(me.x, me.z, R + 0.05)) {
    if (u.isStructure || u.kind === 'ward' || !me.validTarget(u)) continue
    if (champsOnly && !u.isChamp) continue
    const e = edgeDist(me, u)
    if (e > R) continue
    const s = u.isChamp ? (pri === 'lowhp' ? u.hp + u.shieldTotal() : e) : TIER + e
    if (s < bs) { bs = s; best = u }
  }
  return best
}

// ------------------------------------------------------------------ skill targeting
function skillCandidate(w: World, me: Champion, def: SkillDef, u: Unit) {
  if (!castTargetOk(me, def, u) || !w.visibleToMe(u)) return false // same rules as tryCast
  if (def.id === SMITE_ID && u.isChamp) return false // smite only damages monsters and minions
  return true
}

/** smart unit/ally casts. May return `me` for ally skills. */
export function pickSkillUnit(w: World, me: Champion, def: SkillDef, fwd: [number, number], pri: AtkPri): Unit | null {
  const [fx, fz] = unitFwd(me, fwd)
  const fwdAng = Math.atan2(fx, fz)
  const any = def.unitTeam === 'any'
  let best: Unit | null = null, bs = Infinity
  for (const u of w.near(me.x, me.z, def.range + 1.5)) {
    if (!skillCandidate(w, me, def, u)) continue
    const d = dist(me.x, me.z, u.x, u.z)
    if (u !== me && d > def.range + u.radius + 0.5) continue
    let s: number
    if (any) {
      // enemy champion > enemy unit > ally, ties broken by the angle to fwd
      const tier = u.team !== me.team ? (u.isChamp ? 0 : 1) : 2
      const err = d > 1e-3 ? Math.abs(wrapAngle(angleTo(me.x, me.z, u.x, u.z) - fwdAng)) : 0
      s = tier * TIER + err * 1000 + d
    } else if (u.team === me.team) {
      // allies: champions first, then the lowest hp fraction; me wins exact ties
      s = (u.isChamp ? 0 : TIER) + (u.maxHp > 0 ? u.hp / u.maxHp : 1) * 100 - (u === me ? 0.5 : 0)
    } else if (def.id === SMITE_ID) {
      s = (u.kind === 'monster' ? 0 : TIER) - u.maxHp // monsters first, the biggest first
    } else {
      s = (u.isChamp ? 0 : TIER) + (pri === 'lowhp' ? u.hp + u.shieldTotal() : d * 100)
    }
    if (s < bs) { bs = s; best = u }
  }
  return best
}

/** drag-aimed unit/ally casts: the unit closest to the aim ray (never `me`); f ∈ [0,1] = aim length fraction */
export function pickAlongAim(w: World, me: Champion, def: SkillDef, ux: number, uz: number, f: number): Unit | null {
  const aim = Math.atan2(ux, uz)
  let best: Unit | null = null, bs = Infinity
  for (const u of w.near(me.x, me.z, def.range + 1.5)) {
    if (u === me || !skillCandidate(w, me, def, u)) continue
    const d = dist(me.x, me.z, u.x, u.z)
    if (d > def.range + u.radius + 0.5) continue
    const err = d > 1e-3 ? Math.abs(wrapAngle(angleTo(me.x, me.z, u.x, u.z) - aim)) : 0
    const tol = Math.max(0.35, Math.atan2(u.radius + 0.8, Math.max(d, 0.1))) // ≥ 20°, wider for close units
    if (err > tol) continue
    const s = err + (u.isChamp ? 0 : 0.25) + Math.abs(d - f * def.range) * 0.03
    if (s < bs) { bs = s; best = u }
  }
  return best
}

/** where to aim at a moving unit (22 = the projectile speed ai/bot.ts assumes) */
export function leadPoint(me: Champion, t: Unit, def: SkillDef): [number, number] {
  const d = dist(me.x, me.z, t.x, t.z)
  const tau = def.castTime + (def.target === 'dir' ? d / 22 : 0.25)
  return [t.x + (t.vx ?? 0) * tau * 0.7, t.z + (t.vz ?? 0) * tau * 0.7]
}

/** escape skills (flash, wind.E …) follow fwd instead of auto-targeting an enemy */
const followsFwd = (def: SkillDef) => def.id === FLASH_ID || def.bot.use === 'escape'
/** engage dashes / leaps only auto-aim at champions; otherwise they go where the thumb (or facing) points */
const champAimOnly = (def: SkillDef) => def.bot.use === 'engage'

/** tap = smart cast. fwd = joystick direction if held, else facingDir(me). null = no valid target (无效的目标). */
export function smartCastPlan(w: World, me: Champion, key: CastKey, def: SkillDef, fwd: [number, number], pri: AtkPri): CastPlan | null {
  const [fx, fz] = unitFwd(me, fwd)
  switch (def.target) {
    case 'self':
      return { x: me.x, z: me.z, reach: 0 }
    case 'dir': {
      const t = followsFwd(def) ? null : pickEnemyInRange(w, me, def.range + 0.8, pri, champAimOnly(def))
      if (!t) return along(me, fx, fz, def.range)
      const [lx, lz] = leadPoint(me, t, def)
      const l = Math.hypot(lx - me.x, lz - me.z)
      const p = l > 0.05 ? along(me, (lx - me.x) / l, (lz - me.z) / l, def.range) : along(me, fx, fz, def.range)
      p.tid = t.id
      return p
    }
    case 'point': {
      if (followsFwd(def)) return along(me, fx, fz, def.range)
      if (key === '4') return along(me, fx, fz, WARD_SMART_DIST)
      const t = pickEnemyInRange(w, me, def.range + 0.5, pri, champAimOnly(def))
      if (!t) return along(me, fx, fz, def.range * 0.7)
      const [lx, lz] = leadPoint(me, t, def)
      const l = Math.hypot(lx - me.x, lz - me.z)
      const p = l > def.range && !def.noClamp
        ? along(me, (lx - me.x) / l, (lz - me.z) / l, def.range)
        : { x: lx, z: lz, reach: l }
      p.tid = t.id
      return p
    }
    case 'unit':
    case 'ally': {
      const t = pickSkillUnit(w, me, def, [fx, fz], pri)
      if (!t) return null
      if (t === me) return { x: me.x, z: me.z, reach: 0 } // no tid: tryCast falls back to self (selfCast)
      return { x: t.x, z: t.z, tid: t.id, reach: dist(me.x, me.z, t.x, t.z) }
    }
  }
  return null
}

/**
 * Drag = aim. dx/dy = drag vector in CSS px from the press origin, s = UI scale.
 * Inside the dead zone this is the smart cast.
 */
export function aimCastPlan(w: World, me: Champion, key: CastKey, def: SkillDef, dx: number, dy: number, s: number,
  fwd: [number, number], pri: AtkPri): CastPlan | null {
  const k = s > 0 ? s : 1
  const m = Math.hypot(dx, dy)
  const u = m < AIM_DEAD * k ? null : screenVecToWorldDir(dx, dy)
  if (!u) return smartCastPlan(w, me, key, def, fwd, pri)
  const f = clamp((m - AIM_DEAD * k) / ((AIM_MAX - AIM_DEAD) * k), 0, 1)
  switch (def.target) {
    case 'self':
      return { x: me.x, z: me.z, reach: 0 }
    case 'dir':
      return along(me, u[0], u[1], def.range)
    case 'point':
      return along(me, u[0], u[1], def.id === FLASH_ID ? def.range : f * def.range)
    case 'unit':
    case 'ally': {
      const t = pickAlongAim(w, me, def, u[0], u[1], f)
      if (t) return { x: t.x, z: t.z, tid: t.id, reach: dist(me.x, me.z, t.x, t.z) }
      if (def.selfCast && f < 0.2) return { x: me.x, z: me.z, reach: 0 }
      return null
    }
  }
  return null
}
