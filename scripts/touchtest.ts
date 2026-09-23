// Headless tests for src/ui/touchlogic.ts (touch joystick look-ahead, attack / skill targeting, cast plans, HUD layout).
// Run: bun scripts/touchtest.ts
import { World, SlotConfig } from '../src/game/world'
import { Unit } from '../src/game/unit'
import { Champion, castTargetOk } from '../src/game/champion'
import { Minion, Monster, Ward } from '../src/game/npc'
import { CHAMP_MAP } from '../src/game/data/champions'
import { SPELL_MAP, WARD_SKILL } from '../src/game/data/spells'
import { SkillDef } from '../src/game/skills'
import { angleTo, clamp, dist, wrapAngle } from '../src/util/math'
import {
  AIM_DEAD, AIM_MAX, LOOK_MAX, LOOK_MIN, LOOK_T, NARROW_W, PITCH_SIN, SLIDE_MIN_FREE, TC_LAYOUT, TcSpot,
  aaDamage, aimCastPlan, atkReach, edgeDist, facingDir, joyTarget, leadPoint, pickAlongAim, pickAttackTarget,
  pickEnemyInRange, pickSkillUnit, screenVecToWorldDir, smartCastPlan, tcItemPos, tcLvlupPos,
} from '../src/ui/touchlogic'
import { AIM_MAX as TL_AIM_MAX, CANCEL_R_HIT as TL_CANCEL_R_HIT } from '../src/ui/touchlogic'

// ------------------------------------------------------------------ tiny harness
let pass = 0, fail = 0
const fails: string[] = []
let group = ''
function section(name: string) { group = name; console.log(`\n# ${name}`) }
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; fails.push(`${group}: ${name}${detail ? ' — ' + detail : ''}`); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
const fmt = (p: { x: number; z: number } | [number, number] | null | undefined) =>
  !p ? String(p) : Array.isArray(p) ? `(${p[0].toFixed(2)}, ${p[1].toFixed(2)})` : `(${p.x.toFixed(2)}, ${p.z.toFixed(2)})`
const nm = (u: Unit | null | undefined) => (u ? u.id : String(u))

// ------------------------------------------------------------------ fixtures
const ME = 'ember' // ranged: range 6.0, ad 52
function makeWorld(meChamp = ME) {
  const slots: SlotConfig[] = []
  const picks = [meChamp, 'star', 'rock', 'frost', 'thunder', 'blaze', 'wind', 'shade', 'rock', 'frost']
  for (const team of [0, 1] as const) for (let i = 0; i < 5; i++) {
    const slot = (team ? 'r' : 'b') + i
    slots.push({ slot, team, champ: picks[team * 5 + i], name: slot, bot: slot !== 'b0', spells: ['flash', 'smite'], diff: 1 })
  }
  const w = new World('rift', slots, 'b0', 1)
  w.becomeHost()
  return w
}
const champ = (w: World, slot: string) => w.champs.find(c => c.slot === slot)!
const rehash = (w: World) => (w as any).rebuildHash()
let uid = 0
function minion(w: World, team: 0 | 1, x: number, z: number, hp?: number, mt: 'melee' | 'caster' = 'melee') {
  const m = new Minion('tm' + ++uid, mt, team, 'mid', w.map.lanes.mid!, x, z, 0)
  m.local = true
  if (hp !== undefined) m.hp = hp
  w.addUnit(m)
  return m
}
function monster(w: World, mt: 'gromp' | 'wolf', x: number, z: number) {
  const m = new Monster('tj' + ++uid, mt, 'test', x, z, 0, 0, false)
  m.local = true
  w.addUnit(m)
  return m
}
function ward(w: World, team: 0 | 1, x: number, z: number) {
  const u = new Ward('tw' + ++uid, team, x, z, w.now)
  u.local = true
  w.addUnit(u)
  return u
}
function kill(w: World, ...us: Unit[]) { for (const u of us) { u.dead = true; w.removeUnit(u) } }
/** park every champion except the listed ones far away in their fountains */
function park(w: World, keep: Champion[]) {
  for (const c of w.champs) if (!keep.includes(c)) { const f = w.map.fountains[c.team as 0 | 1]; c.x = f.x; c.z = f.z }
}
const skill = (champ: string, i: number): SkillDef => CHAMP_MAP[champ].skills[i]
const at = (u: Unit, x: number, z: number) => { u.x = x; u.z = z; return u }

const CX = 90, CZ = 90 // open mid-lane ground on rift (walkable disk of radius 6)

// ------------------------------------------------------------------ screenVecToWorldDir
section('screenVecToWorldDir')
{
  const up = screenVecToWorldDir(0, -50)!
  check('screen up → world −z', near(up[0], 0) && near(up[1], -1), fmt(up))
  const right = screenVecToWorldDir(30, 0)!
  check('screen right → world +x', near(right[0], 1) && near(right[1], 0), fmt(right))
  const diag = screenVecToWorldDir(40, -40)!
  check('diagonal: x/|z| ≈ 0.839', near(diag[0] / Math.abs(diag[1]), PITCH_SIN, 1e-9) && diag[1] < 0, fmt(diag))
  check('unit length', near(Math.hypot(diag[0], diag[1]), 1))
  check('zero vector → null', screenVecToWorldDir(0, 0) === null)
}

// ------------------------------------------------------------------ joyTarget
section('joyTarget')
{
  const w = makeWorld()
  const me = w.me!, g = w.grid
  park(w, [me])
  at(me, CX, CZ)
  const L = clamp(me.moveSpeed() * LOOK_T, LOOK_MIN, LOOK_MAX)
  const p = joyTarget(w, me, 0, -1)
  check('open ground: straight look-ahead of length L', !!p && near(p[0], CX) && near(p[1], CZ - L), `${fmt(p)} L=${L.toFixed(2)}`)
  check('open ground: target walkable and in LOS', !!p && g.isWalkable(p[0], p[1]) && g.los(me.x, me.z, p[0], p[1]))
  const d = Math.SQRT1_2, pd = joyTarget(w, me, d, d)
  check('open ground diagonal: full length', !!pd && near(dist(me.x, me.z, pd[0], pd[1]), L), fmt(pd))
  me.cmdMove(p![0], p![1])
  check('cmdMove to it takes the LOS fast path (1 waypoint)', me.path?.length === 1, JSON.stringify(me.path))
  me.cmdStop()

  // off-grid (inside a wall): return me + u·L and let findPath snap
  let wallPt: [number, number] | null = null
  for (let x = CX; x < CX + 20 && !wallPt; x += 0.5) if (!g.isWalkable(x, CZ)) wallPt = [x + 1, CZ]
  at(me, wallPt![0], wallPt![1])
  const po = joyTarget(w, me, 1, 0)
  check('off-grid: me + u·L', !g.isWalkable(me.x, me.z) && !!po && near(po[0], me.x + L) && near(po[1], me.z), fmt(po))

  // boxed in: block the 8 cells around me's cell
  at(me, CX + 0.5, CZ + 0.5)
  const ci = Math.floor(me.x), cj = Math.floor(me.z), S = g.S, saved: [number, number][] = []
  for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) {
    if (i === ci && j === cj) continue
    const k = j * S + i
    saved.push([k, g.block[k]])
    g.block[k] = 1
  }
  const pb = [joyTarget(w, me, 1, 0), joyTarget(w, me, 0, -1), joyTarget(w, me, -d, d)]
  check('boxed in: null in every direction', pb.every(x => x === null), pb.map(fmt).join(' '))
  for (const [k, v] of saved) g.block[k] = v
  check('unboxed again: straight target', joyTarget(w, me, 1, 0) !== null)
}

for (const into of [30, 45, 60]) {
  section(`joyTarget: sliding along a wall, pushing ${into}° into it (real movement)`)
  const w = makeWorld()
  const me = w.me!, g = w.grid
  park(w, [me])
  // top lane on rift: straight map-border wall at x = 8 for z ∈ [60, 94]; walkable x ∈ [8, 20]
  const WALL_X = 8
  check('fixture: straight wall at x=8 for z ∈ [62, 92]', [62, 70, 80, 92].every(z => !g.isWalkable(WALL_X - 0.5, z) && g.isWalkable(WALL_X + 0.5, z) && g.isWalkable(WALL_X + 4, z)))
  at(me, WALL_X + 1.5, 88)
  const a = into * Math.PI / 180
  const ux = -Math.sin(a), uz = -Math.cos(a) // north (−z) along the wall, turned `into`° toward it (−x)
  const x0 = me.x, z0 = me.z
  let okAll = true, losAll = true, fast = true, stuck = 0, issued = 0, detail = '', minX = Infinity
  let first: [number, number] | null = null
  for (let i = 0; i < 40; i++) {
    const p = joyTarget(w, me, ux, uz)
    if (!p) { okAll = false; detail = `null at step ${i} ${fmt([me.x, me.z])}`; break }
    if (!first) first = p
    issued++
    if (!g.isWalkable(p[0], p[1])) { okAll = false; detail = `unwalkable target ${fmt(p)}` }
    if (!g.los(me.x, me.z, p[0], p[1])) { losAll = false; detail = `no LOS to ${fmt(p)} from ${fmt([me.x, me.z])}` }
    if (dist(me.x, me.z, p[0], p[1]) < SLIDE_MIN_FREE - 1e-9) { okAll = false; detail = `too short ${fmt(p)}` }
    me.cmdMove(p[0], p[1])
    if (me.path?.length !== 1) fast = false
    const bx = me.x, bz = me.z
    w.update(0.1, w.time * 1000 + 100)
    minX = Math.min(minX, me.x)
    if (dist(bx, bz, me.x, me.z) < 0.1) stuck++
  }
  check('first target progresses along the wall', !!first && (first[0] - x0) * ux + (first[1] - z0) * uz > 0 && Math.abs(first[1] - z0) > Math.abs(first[0] - x0) * 0.5, fmt(first))
  check('every target walkable and at least SLIDE_MIN_FREE away', okAll, detail)
  check('every target in grid LOS', losAll, detail)
  check('every cmdMove took the LOS fast path', fast)
  check('never stuck', stuck === 0, `stuck steps ${stuck}/${issued}`)
  check('kept advancing along the wall (≥ 8 units north in 4 s)', z0 - me.z >= 8, `Δz=${(me.z - z0).toFixed(2)}`)
  check('hugs the wall without crossing it', minX >= WALL_X && me.x < WALL_X + 2, `minX=${minX.toFixed(2)} x=${me.x.toFixed(2)}`)
}

// ------------------------------------------------------------------ attack targeting
section('atkReach / edgeDist / aaDamage')
{
  const w = makeWorld()
  const me = w.me!
  const m = minion(w, 1, CX + 3, CZ)
  check('atkReach = range + radius', near(atkReach(me), me.stats.range + me.radius))
  at(me, CX, CZ)
  check('edgeDist = dist − radius', near(edgeDist(me, m), 3 - m.radius))
  check('edgeDist ≤ atkReach ⇔ inAtkRange', (edgeDist(me, m) <= atkReach(me)) === me.inAtkRange(m))
  check('aaDamage vs 0-armor minion = ad', near(aaDamage(me, m), me.stats.ad), `${aaDamage(me, m)} vs ${me.stats.ad}`)
  const r0 = champ(w, 'r0')
  check('aaDamage vs champion is armor-mitigated', near(aaDamage(me, r0), me.stats.ad * 100 / (100 + r0.stats.armor)))
}

section('pickAttackTarget')
{
  const w = makeWorld()
  const me = w.me!
  const r0 = champ(w, 'r0'), r1 = champ(w, 'r1')
  park(w, [me])
  at(me, CX, CZ)
  const reach = atkReach(me)
  const P = { joy: false, pri: 'lowhp' as const, focus: null as Unit | null }
  const pick = (mode: 'main' | 'minion' | 'tower', cur: Unit | null = null, o: Partial<typeof P> = {}) => {
    rehash(w)
    return pickAttackTarget(w, me, mode, cur, { ...P, ...o })
  }
  const m1 = minion(w, 1, CX + 3, CZ) // full hp melee
  check('lone minion in range', pick('main') === m1, nm(pick('main')))
  const m3 = minion(w, 1, CX + 2, CZ + 2, 100, 'caster') // low but not AA-killable
  check('lowest-HP lane minion preferred (not killable)', pick('main') === m3, nm(pick('main')))
  const m2 = minion(w, 1, CX + 4, CZ + 1, aaDamage(me, m1) - 1) // last-hittable
  check('last-hittable minion beats low-HP minion', pick('main') === m2, nm(pick('main')))
  at(r0, CX + 5, CZ - 2)
  check('champion beats last-hit in main mode', pick('main') === r0, nm(pick('main')))
  check('minion mode ignores champions (last hit first)', pick('minion') === m2, nm(pick('minion')))
  check('tower mode with no structure → null', pick('tower') === null)
  const wd = ward(w, 1, CX - 2, CZ)
  kill(w, m1, m2, m3); park(w, [me])
  check('ward is attackable in main mode when alone', pick('main') === wd, nm(pick('main')))
  check('minion mode includes wards', pick('minion') === wd, nm(pick('minion')))
  kill(w, wd)

  // focus
  const f1 = minion(w, 1, CX + 3, CZ)
  at(r0, CX + 4, CZ - 1)
  check('focused unit wins over a champion', pick('main', null, { focus: f1 }) === f1)
  at(f1, CX + reach + 1.2 + 2 + f1.radius + 0.5, CZ) // beyond R + 2
  check('focused unit beyond R+2 is ignored', pick('main', null, { focus: f1 }) === r0, nm(pick('main', null, { focus: f1 })))
  kill(w, f1)

  // joystick active: no chasing beyond reach + 0.2
  park(w, [me])
  const far = minion(w, 1, CX + reach + 0.8 + 0.5, CZ) // edge distance reach + 0.8 (inside ranged slack 1.2)
  check('chase target inside slack when not steering', pick('main') === far, nm(pick('main')))
  check('no chase target while steering (joy)', pick('main', null, { joy: true }) === null)
  kill(w, far)

  // champion priority
  at(r0, CX + 2, CZ) // near, full hp
  at(r1, CX + 5.5, CZ + 1); r1.hp = r1.maxHp * 0.4 // farther, low (not AA-killable)
  check('lowhp picks the low-HP champion', pick('main') === r1, nm(pick('main')))
  check('near picks the nearest champion', pick('main', null, { pri: 'near' }) === r0, nm(pick('main', null, { pri: 'near' })))
  // stickiness
  check('sticky: keep current champion over a lower-HP one', pick('main', r0) === r0, nm(pick('main', r0)))
  r1.hp = aaDamage(me, r1) - 1
  check('sticky exception: switch to an AA-killable champion', pick('main', r0) === r1, nm(pick('main', r0)))
  r1.hp = r1.maxHp
  // vision
  r0.vis[0] = false
  check('invisible champion is skipped', pick('main', null, { pri: 'near' }) === r1, nm(pick('main', null, { pri: 'near' })))
  r0.vis[0] = true
  park(w, [me])

  // stickiness among minions
  const s1 = minion(w, 1, CX + 3, CZ) // full
  const s2 = minion(w, 1, CX + 2, CZ + 2, 200) // lower hp, same class
  check('sticky: keep current minion over a lower-HP one', pick('main', s1) === s1, nm(pick('main', s1)))
  const s3 = minion(w, 1, CX + 1, CZ - 3, 10)
  check('switch when a strictly better class (last hit) appears', pick('main', s1) === s3, nm(pick('main', s1)))
  kill(w, s3)
  at(s1, CX + reach + 1.2 + 0.8 + s1.radius, CZ) // outside R but within R + KEEP_EXTRA
  check('sticky within R + KEEP_EXTRA', pick('main', s1) === s1, nm(pick('main', s1)))
  at(s1, CX + reach + 1.2 + 1.5 + s1.radius, CZ)
  check('dropped beyond R + KEEP_EXTRA', pick('main', s1) === s2, nm(pick('main', s1)))
  kill(w, s1, s2)

  // towers: tier-1 red mid tower (unprotected), tier-2 (protected)
  const t1 = w.towers.find(t => t.id === 'tr-mid-1')!, t2 = w.towers.find(t => t.id === 'tr-mid-2')!
  const spot = (t: Unit, e: number): [number, number] => {
    for (let a = 0; a < Math.PI * 2; a += 0.1) {
      const x = t.x + Math.cos(a) * (t.radius + e), z = t.z + Math.sin(a) * (t.radius + e)
      if (w.grid.isWalkable(x, z) && w.grid.isWalkable(x + 1, z) && w.grid.isWalkable(x - 1, z)) return [x, z]
    }
    throw new Error('no walkable spot near ' + t.id)
  }
  const [tx, tz] = spot(t1, reach - 1)
  at(me, tx, tz)
  const tm = minion(w, 1, tx + (tx < t1.x ? -1.5 : 1.5), tz)
  check('tower mode targets the tower', pick('tower') === t1, nm(pick('tower')))
  check('main mode prefers the minion over the tower', pick('main') === tm, nm(pick('main')))
  kill(w, tm)
  check('main mode falls back to the tower', pick('main') === t1, nm(pick('main')))
  check('minion mode ignores the tower', pick('minion') === null)
  const [ux, uz] = spot(t2, reach - 1)
  at(me, ux, uz)
  check('protected tower is not a target', w.isProtected(t2) && pick('tower') === null && pick('main') === null, nm(pick('tower')))
}

section('pickEnemyInRange')
{
  const w = makeWorld()
  const me = w.me!, r0 = champ(w, 'r0'), r1 = champ(w, 'r1')
  park(w, [me])
  at(me, CX, CZ)
  const m = minion(w, 1, CX + 2, CZ)
  const far = minion(w, 1, CX + 4, CZ)
  ward(w, 1, CX + 1, CZ)
  rehash(w)
  check('nearest lane unit when no champion (wards skipped)', pickEnemyInRange(w, me, 8, 'lowhp') === m)
  at(r0, CX + 6, CZ); at(r1, CX + 3, CZ + 1); r0.hp = r0.maxHp * 0.3
  rehash(w)
  check('champion first by lowhp', pickEnemyInRange(w, me, 8, 'lowhp') === r0)
  check('champion first by near', pickEnemyInRange(w, me, 8, 'near') === r1)
  check('range limit (edge distance)', pickEnemyInRange(w, me, 3, 'lowhp') === r1 && pickEnemyInRange(w, me, 1.2, 'lowhp') === null,
    nm(pickEnemyInRange(w, me, 1.2, 'lowhp')))
  void far
}

// ------------------------------------------------------------------ skill targeting
section('castTargetOk (extracted from tryCast)')
{
  const w = makeWorld()
  const me = w.me!, r0 = champ(w, 'r0'), b1 = champ(w, 'b1')
  park(w, [me])
  at(me, CX, CZ)
  const m = minion(w, 1, CX + 2, CZ), om = minion(w, 0, CX - 2, CZ), mon = monster(w, 'wolf', CX, CZ + 3)
  const wd = ward(w, 1, CX + 1, CZ + 1)
  at(r0, CX + 3, CZ - 1); at(b1, CX - 3, CZ + 1)
  // the closure tryCast used before the extraction, copied verbatim for comparison
  const legacy = (self: Champion, def: SkillDef, u: Unit | null): boolean => {
    if (!u || u.dead || !u.targetable()) return false
    if (u.isStructure || u.kind === 'ward') return false
    if (def.champOnly && !u.isChamp) return false
    const team = def.unitTeam ?? (def.target === 'ally' ? 'ally' : 'enemy')
    if (team === 'enemy' && u.team === self.team) return false
    if (team === 'ally' && u.team !== self.team) return false
    if (u === self && def.target !== 'ally') return false
    if (u.team !== self.team && !self.world.canSee(self.team, u)) return false
    return true
  }
  const defs = [skill('blaze', 3), skill('rock', 0), skill('shade', 2), skill('shade', 3), skill('star', 2), skill('frost', 1), skill('ember', 2),
    SPELL_MAP.smite.skill, SPELL_MAP.ignite.skill]
  const units: (Unit | null)[] = [null, me, r0, b1, m, om, mon, wd, w.towers[0]]
  let same = true, bad = ''
  for (const vis of [true, false]) {
    r0.vis[0] = vis; m.vis[0] = vis
    for (const d of defs) for (const u of units) if (castTargetOk(me, d, u) !== legacy(me, d, u)) { same = false; bad = `${d.id} ${nm(u)}` }
  }
  r0.vis[0] = true; m.vis[0] = true
  check('identical to the legacy closure on every def × unit', same, bad)
  // tryCast still uses it: ember.E on an invisible champion → notarget; on a visible minion → ok
  r0.vis[0] = false
  check('tryCast: invisible champion → notarget', me.tryCast('E', r0.x, r0.z, r0.id) === 'notarget')
  r0.vis[0] = true
  check('tryCast: visible minion in range → ok', me.tryCast('E', m.x, m.z, m.id) === 'ok')
}

section('pickSkillUnit')
{
  const w = makeWorld()
  const me = w.me!, r0 = champ(w, 'r0'), r1 = champ(w, 'r1'), b1 = champ(w, 'b1')
  const fwd = facingDir(me)
  park(w, [me])
  at(me, CX, CZ)
  const blazeR = skill('blaze', 3), rockQ = skill('rock', 0), shadeE = skill('shade', 2), starE = skill('star', 2)
  const smite = SPELL_MAP.smite.skill
  const psu = (d: SkillDef, pri: 'lowhp' | 'near' = 'lowhp', f: [number, number] = fwd) => { rehash(w); return pickSkillUnit(w, me, d, f, pri) }
  const m = minion(w, 1, CX + 2, CZ)
  check('champOnly (blaze.R): minion only → null', psu(blazeR) === null, nm(psu(blazeR)))
  check('unit (rock.Q): minion only → minion', psu(rockQ) === m)
  at(r0, CX + 4, CZ + 1)
  check('champOnly (blaze.R): champion in range', psu(blazeR) === r0)
  check('unit (rock.Q): champion before minion', psu(rockQ) === r0)
  at(r0, CX + 4.5 + r0.radius + 0.4, CZ)
  check('within range + radius + 0.5', psu(blazeR) === r0)
  at(r0, CX + 4.5 + r0.radius + 0.7, CZ)
  check('beyond range + radius + 0.5 → null', psu(blazeR) === null)
  r0.vis[0] = false; at(r0, CX + 3, CZ)
  check('invisible champion skipped', psu(blazeR) === null)
  r0.vis[0] = true
  at(r1, CX - 4, CZ); r1.hp = r1.maxHp * 0.3
  check('two champions: lowhp', psu(blazeR, 'lowhp') === r1)
  check('two champions: near', psu(blazeR, 'near') === r0)
  park(w, [me])

  // smite: monsters first, biggest first; never champions
  const wolf = monster(w, 'wolf', CX - 2, CZ + 2)
  check('smite: monster over a nearer minion', psu(smite) === wolf, nm(psu(smite)))
  const gromp = monster(w, 'gromp', CX + 1, CZ - 3)
  check('smite: biggest maxHp monster', psu(smite) === gromp, nm(psu(smite)))
  kill(w, wolf, gromp, m)
  at(r0, CX + 2, CZ)
  check('smite: never a champion', psu(smite) === null, nm(psu(smite)))
  park(w, [me])

  // ally (star.E, selfCast)
  check('ally skill alone → me', psu(starE) === me)
  at(b1, CX + 4, CZ); b1.hp = b1.maxHp * 0.5
  check('ally skill → lowest hp fraction ally', psu(starE) === b1)
  me.hp = me.maxHp * 0.3
  check('ally skill → me when I am lower', psu(starE) === me)
  me.hp = me.maxHp; b1.hp = b1.maxHp
  check('ally skill tie → me', psu(starE) === me)
  at(b1, CX + 12, CZ); b1.hp = b1.maxHp * 0.2
  check('ally out of range → me', psu(starE) === me)
  b1.hp = b1.maxHp

  // shade.E (any): enemy champ > enemy unit > ally, ties by angle to fwd
  at(b1, CX - 2, CZ)
  check('any: ally only → ally', psu(shadeE) === b1, nm(psu(shadeE)))
  const em = minion(w, 1, CX + 3, CZ + 2)
  check('any: enemy unit over ally', psu(shadeE) === em, nm(psu(shadeE)))
  at(r0, CX + 5, CZ)
  check('any: enemy champion over enemy unit', psu(shadeE) === r0, nm(psu(shadeE)))
  at(r0, CX + 4, CZ); at(r1, CX, CZ - 4); r1.hp = r1.maxHp
  check('any: tie broken by angle to fwd (east)', psu(shadeE, 'lowhp', [1, 0]) === r0, nm(psu(shadeE, 'lowhp', [1, 0])))
  check('any: tie broken by angle to fwd (north)', psu(shadeE, 'lowhp', [0, -1]) === r1, nm(psu(shadeE, 'lowhp', [0, -1])))
}

section('pickAlongAim')
{
  const w = makeWorld()
  const me = w.me!, r0 = champ(w, 'r0'), r1 = champ(w, 'r1'), b1 = champ(w, 'b1')
  park(w, [me])
  at(me, CX, CZ)
  at(r0, CX + 4, CZ); at(r1, CX, CZ - 4)
  rehash(w)
  const blazeR = skill('blaze', 3), starE = skill('star', 2)
  check('aim east → east champion', pickAlongAim(w, me, blazeR, 1, 0, 0.8) === r0)
  check('aim north → north champion', pickAlongAim(w, me, blazeR, 0, -1, 0.8) === r1)
  check('aim south → nothing', pickAlongAim(w, me, blazeR, 0, 1, 0.8) === null)
  const east = (deg: number): [number, number] => { const a = Math.PI / 2 - deg * Math.PI / 180; return [Math.sin(a), Math.cos(a)] }
  check('aim 18° off still hits (tolerance ≥ 20°)', pickAlongAim(w, me, blazeR, ...east(18), 0.8) === r0)
  check('aim 30° off misses at d=4', pickAlongAim(w, me, blazeR, ...east(30), 0.8) === null)
  at(r0, CX + 2, CZ)
  rehash(w)
  check('aim 30° off hits a close unit (d=2, wider tolerance)', pickAlongAim(w, me, blazeR, ...east(30), 0.8) === r0)
  at(r0, CX + 4, CZ)
  at(b1, CX - 4, CZ)
  rehash(w)
  check('ally skill: aim west → ally, never me', pickAlongAim(w, me, starE, -1, 0, 0.5) === b1 && pickAlongAim(w, me, starE, 0, 1, 0.1) === null)
}

section('leadPoint')
{
  const w = makeWorld()
  const me = w.me!, r0 = champ(w, 'r0')
  at(me, CX, CZ); at(r0, CX + 6, CZ)
  const q = skill('wind', 0) // dir, castTime 0.22
  check('stationary target → its position', near(leadPoint(me, r0, q)[0], r0.x) && near(leadPoint(me, r0, q)[1], r0.z))
  r0.vx = 0; r0.vz = 3
  const tau = q.castTime + 6 / 22
  const lp = leadPoint(me, r0, q)
  check('dir: lead = v·(castTime + d/22)·0.7', near(lp[1], r0.z + 3 * tau * 0.7) && near(lp[0], r0.x), fmt(lp))
  const pw = skill('star', 1) // point
  check('point: lead = v·(castTime + 0.25)·0.7', near(leadPoint(me, r0, pw)[1], r0.z + 3 * (pw.castTime + 0.25) * 0.7))
}

// ------------------------------------------------------------------ cast plans
section('smartCastPlan')
{
  const w = makeWorld()
  const me = w.me!, r0 = champ(w, 'r0')
  park(w, [me])
  at(me, CX, CZ)
  const fwd: [number, number] = [0, -1]
  const flash = SPELL_MAP.flash.skill
  const plan = (key: string, d: SkillDef, f: [number, number] = fwd) => { rehash(w); return smartCastPlan(w, me, key as any, d, f, 'lowhp') }
  at(r0, CX + 3, CZ + 1)
  const pf = plan('D', flash)
  check('flash: full range along fwd, never at an enemy', !!pf && near(pf.x, CX) && near(pf.z, CZ - flash.range) && !pf.tid && near(pf.reach, flash.range), fmt(pf))
  const pw = plan('4', WARD_SKILL)
  check('ward: 1.5 ahead', !!pw && near(pw.x, CX) && near(pw.z, CZ - 1.5), fmt(pw))
  const wq = skill('wind', 0)
  const pq = plan('Q', wq)
  const ang = pq ? angleTo(me.x, me.z, pq.x, pq.z) : NaN
  check('dir with enemy: aimed at it, full range, tid set', !!pq && near(ang, angleTo(me.x, me.z, r0.x, r0.z), 1e-6) && near(dist(me.x, me.z, pq.x, pq.z), wq.range) && pq.tid === r0.id, fmt(pq))
  const we = skill('wind', 2) // escape dash
  const pe = plan('E', we)
  check('dir escape skill follows fwd', !!pe && near(pe.x, CX) && near(pe.z, CZ - we.range) && !pe.tid, fmt(pe))
  const sw = skill('star', 1) // point, range 9
  const pp = plan('W', sw)
  check('point with enemy: at the (lead) point, tid set', !!pp && near(pp.x, r0.x) && near(pp.z, r0.z) && pp.tid === r0.id, fmt(pp))
  at(r0, CX + 9.3, CZ) // edge 8.65 < range + 0.5 → targeted, point clamped to range
  const pc = plan('W', sw)
  check('point: out-of-range lead point clamped to range', !!pc && near(dist(me.x, me.z, pc.x, pc.z), sw.range) && pc.tid === r0.id, fmt(pc))
  park(w, [me])
  const pq0 = plan('Q', wq)
  check('dir without enemy: fwd · range', !!pq0 && near(pq0.x, CX) && near(pq0.z, CZ - wq.range) && !pq0.tid, fmt(pq0))
  const pp0 = plan('W', sw)
  check('point without enemy: fwd · 0.7·range', !!pp0 && near(pp0.z, CZ - 0.7 * sw.range) && near(pp0.x, CX), fmt(pp0))
  const pr = plan('R', skill('blaze', 3))
  check('unit without target → null', pr === null)
  const pa = plan('E', skill('star', 2))
  check('ally alone → self point, no tid', !!pa && near(pa.x, me.x) && near(pa.z, me.z) && pa.tid === undefined, fmt(pa))
  const ps = plan('W', skill('blaze', 1))
  check('self → me', !!ps && near(ps.x, me.x) && near(ps.z, me.z) && ps.reach === 0)
  me.facing = Math.PI / 2
  const pff = plan('D', flash, [0, 0])
  check('zero fwd falls back to facing', !!pff && near(pff.x, CX + flash.range) && near(pff.z, CZ, 1e-9), fmt(pff))
  check('facingDir(π/2) = (1, 0)', near(facingDir(me)[0], 1) && near(facingDir(me)[1], 0, 1e-12))
}

section('aimCastPlan')
{
  const w = makeWorld()
  const me = w.me!, r0 = champ(w, 'r0')
  park(w, [me])
  at(me, CX, CZ)
  at(r0, CX + 3, CZ)
  rehash(w)
  const fwd: [number, number] = [0, -1]
  const aim = (key: string, d: SkillDef, dx: number, dy: number, s = 1) => aimCastPlan(w, me, key as any, d, dx, dy, s, fwd, 'lowhp')
  const wq = skill('wind', 0), sw = skill('star', 1), flash = SPELL_MAP.flash.skill
  const dz = aim('Q', wq, 5, -5), sm = smartCastPlan(w, me, 'Q', wq, fwd, 'lowhp')
  check('inside the dead zone = smart cast', JSON.stringify(dz) === JSON.stringify(sm), `${fmt(dz)} vs ${fmt(sm)}`)
  const dq = aim('Q', wq, 100, 0)
  check('dir drag right → +x at full range', !!dq && near(dq.x, CX + wq.range) && near(dq.z, CZ), fmt(dq))
  const fAt = (m: number, s: number) => clamp((m - AIM_DEAD * s) / ((AIM_MAX - AIM_DEAD) * s), 0, 1)
  const dp = aim('W', sw, 0, -55)
  check('point drag up 55px → me + (0, −f·range)', !!dp && near(dp.x, CX) && near(dp.z, CZ - fAt(55, 1) * sw.range), fmt(dp))
  const dp2 = aim('W', sw, 0, -55 * 1.3, 1.3)
  check('scaled drag at s=1.3 gives the same point', !!dp2 && near(dp2.z, dp!.z, 1e-9), fmt(dp2))
  const dmax = aim('W', sw, 0, -400)
  check('point drag saturates at range', !!dmax && near(dmax.z, CZ - sw.range))
  const df = aim('D', flash, 0, -20)
  check('flash drag → full range', !!df && near(df.z, CZ - flash.range), fmt(df))
  const du = aim('R', skill('blaze', 3), 80, 4)
  check('unit drag toward an enemy champion → tid', !!du && du.tid === r0.id, fmt(du))
  const dn = aim('R', skill('blaze', 3), -80, 0)
  check('unit drag toward nothing → null', dn === null)
  const starE = skill('star', 2)
  const ds = aim('E', starE, 0, 30) // f < 0.2
  check('selfCast ally, short drag, nothing there → self', !!ds && near(ds.x, me.x) && near(ds.z, me.z) && !ds.tid, fmt(ds))
  const dl = aim('E', starE, 0, 100)
  check('selfCast ally, long drag, nothing there → null', dl === null)
  const dself = aim('E', skill('blaze', 2), 60, 60)
  check('self skill ignores the drag', !!dself && near(dself.x, me.x) && near(dself.z, me.z))
}

// ------------------------------------------------------------------ HUD layout
section('TC_LAYOUT')
{
  type Circ = { n: string; x: number; y: number; r: number }
  const L = TC_LAYOUT
  const spots: [string, TcSpot][] = (['main', 'Q', 'W', 'E', 'R', 'D', 'F', 'ward', 'minion', 'tower', 'recall', 'cancel'] as const).map(k => [k, L[k]])
  const circles = (s: number, narrow = false): Circ[] => {
    const out: Circ[] = []
    for (const [n, [dx, dy, d]] of spots) {
      if (narrow && (n === 'minion' || n === 'tower')) continue
      out.push({ n, x: dx * s, y: dy * s, r: d * s / 2 })
    }
    for (const k of ['Q', 'W', 'E', 'R'] as const) {
      const [x, y] = tcLvlupPos(k)
      out.push({ n: 'lvlup' + k, x: x * s, y: y * s, r: L.LVLUP.size * s / 2 })
    }
    for (let i = 0; i < (narrow ? L.ITEMS.maxNarrow : L.ITEMS.max); i++) {
      const [x, y] = tcItemPos(i, s)
      out.push({ n: 'item' + i, x, y, r: L.ITEMS.size * s / 2 })
    }
    return out
  }
  check('lvlup Q/W/E/R at the documented centres', [['Q', -169, 0], ['W', -146.1, -84.5], ['E', -84.5, -146.1], ['R', 0, -169]]
    .every(([k, x, y]) => { const p = tcLvlupPos(k as 'Q'); return near(p[0], x as number, 0.1) && near(p[1], y as number, 0.1) }))
  check('item row at s=1 matches ITEMS.step', near(tcItemPos(1, 1)[0] - tcItemPos(0, 1)[0], L.ITEMS.step))
  {
    // a full-length aim drag started on any skill centre must not end inside the cancel zone
    const c = L.cancel
    let worst = Infinity, who = ''
    for (const k of ['Q', 'W', 'E', 'R', 'D', 'F', 'ward'] as const) {
      const m = Math.hypot(L[k][0] - c[0], L[k][1] - c[1]) - (TL_AIM_MAX + TL_CANCEL_R_HIT)
      if (m < worst) { worst = m; who = k }
    }
    check('cancel zone is outside every full-length aim drag', worst >= 0, `${who} margin ${worst.toFixed(1)}px`)
  }
  // a level-up badge sits against its own skill (44 − 28 − 14 = 2px at s=1): checked separately for "no overlap"
  const badge = (a: Circ, b: Circ) => a.n === 'lvlup' + b.n || b.n === 'lvlup' + a.n
  for (const s of [0.8, 1, 1.3]) {
    const cs = circles(s)
    let worst = Infinity, pair = '', worstBadge = Infinity
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      const a = cs[i], b = cs[j], gap = Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r
      if (badge(a, b)) { worstBadge = Math.min(worstBadge, gap); continue }
      if (gap < worst) { worst = gap; pair = `${a.n}/${b.n}` }
    }
    check(`pairwise gaps ≥ 4px at s=${s}`, worst >= 4 - 1e-9, `min gap ${worst.toFixed(2)}px (${pair})`)
    check(`level-up badges do not overlap their skill at s=${s}`, worstBadge > 0, `min gap ${worstBadge.toFixed(2)}px`)
  }
  // fits inside the safe area on reference screens (anchor: right = sr + 66s, bottom = sb + 62s)
  const screens = [
    { n: '844×390 notch', vw: 844, vh: 390, l: 47, r: 47, b: 21, t: 0 },
    { n: '667×375 SE', vw: 667, vh: 375, l: 8, r: 8, b: 4, t: 0 },
    { n: '932×430 notch', vw: 932, vh: 430, l: 59, r: 59, b: 21, t: 0 },
    { n: '844×330 Safari toolbar', vw: 844, vh: 330, l: 47, r: 47, b: 21, t: 0 },
    { n: '1180×820 tablet', vw: 1180, vh: 820, l: 8, r: 8, b: 4, t: 0 },
  ]
  for (const sc of screens) {
    const s = clamp(Math.min(sc.vh / 390, sc.vw / 844), 0.8, 1.3)
    const ax = sc.vw - sc.r - L.ANCHOR.right * s, ay = sc.vh - sc.b - L.ANCHOR.bottom * s
    let bad = ''
    for (const c of circles(s, sc.vw < NARROW_W)) {
      const x = ax + c.x, y = ay + c.y
      if (x - c.r < sc.l - 1e-9 || x + c.r > sc.vw - sc.r + 1e-9 || y - c.r < sc.t - 1e-9 || y + c.r > sc.vh - sc.b + 1e-9) bad += `${c.n}@${x.toFixed(0)},${y.toFixed(0)} `
    }
    check(`cluster inside the safe area at ${sc.n} (s=${s.toFixed(2)})`, !bad, bad)
    const cl = circles(s, sc.vw < NARROW_W), leftmost = Math.min(...cl.map(c => ax + c.x - c.r))
    check(`cluster clear of the joystick rest ring at ${sc.n}`, leftmost > sc.l + 118 * s + 58 * s, `leftmost ${leftmost.toFixed(0)}`)
  }
}

// ------------------------------------------------------------------ summary
console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`)
if (fail) { for (const f of fails) console.log('  - ' + f); process.exit(1) }
