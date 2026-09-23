import type { World } from '../world'
import { Champion } from '../champion'
import { Unit } from '../unit'
import { Minion, Monster } from '../npc'
import { LaneId } from '../mapdef'
import { ITEM_MAP } from '../data/items'
import { SKILL_KEYS, CastKey, F } from '../types'
import { TOWER_RANGE } from '../data/units'
import { P2, closestS, dist, pointAlong, polylineLength } from '../../util/math'
import { estimate } from '../combat'

type Role = 'top' | 'mid' | 'bot' | 'support' | 'jungle'

const ROLES: Record<number, Role[]> = {
  1: ['mid'],
  2: ['mid', 'bot'],
  3: ['top', 'mid', 'bot'],
  4: ['top', 'mid', 'bot', 'jungle'],
  5: ['top', 'jungle', 'mid', 'bot', 'support'],
}

export class BotBrain {
  role: Role
  lane: LaneId
  path: P2[]
  pathLen: number
  private next = 0
  private interval: number
  private aimErr: number
  private skillChance: number
  private retreating = false
  private lastPos: P2 = [0, 0]
  private stuckT = 0
  private jungleCamp: string | null = null
  private boughtStart = false
  private baseLane: LaneId

  constructor(private w: World, private c: Champion) {
    const mates = w.champs.filter(o => o.team === c.team).sort((a, b) => a.slot.localeCompare(b.slot))
    const roles = ROLES[Math.min(5, Math.max(1, mates.length))]
    this.role = w.map.laneIds.length === 1 ? 'mid' : roles[mates.indexOf(c)] ?? 'mid'
    this.lane = this.role === 'support' ? 'bot' : this.role === 'jungle' ? 'mid' : (this.role as LaneId)
    if (!w.map.lanes[this.lane]) this.lane = w.map.laneIds[0]
    this.baseLane = this.lane
    const pts = w.map.lanes[this.lane]!
    this.path = c.team === 0 ? pts : [...pts].reverse()
    this.pathLen = polylineLength(this.path)
    const d = c.diff
    this.interval = d >= 2 ? 0.18 : d === 1 ? 0.3 : 0.5
    this.aimErr = d >= 2 ? 0.25 : d === 1 ? 0.8 : 1.6
    this.skillChance = d >= 2 ? 0.95 : d === 1 ? 0.75 : 0.45
    this.next = w.now + Math.random() * 0.5
    if (this.role === 'jungle' && !c.spells.includes('smite')) c.spells = ['flash', 'smite']
  }

  think(_dt: number) {
    const w = this.w, c = this.c
    if (w.now < this.next) return
    this.next = w.now + this.interval * (0.8 + Math.random() * 0.4)
    this.levelSkills()
    if (c.dead) { this.shop(); return }
    if (w.winner !== -1) { c.cmdStop(); return }
    if (c.canShop()) this.shop()
    if (c.casting || c.dash) return
    this.checkStuck()
    this.decide()
  }

  private levelSkills() {
    const c = this.c
    let guard = 4
    while (c.skillPoints > 0 && guard-- > 0) {
      let done = false
      for (const i of [3, 0, 1, 2]) { if (c.levelSkill(i)) { done = true; break } }
      if (!done) break
    }
  }

  /** the next complete item of the build that we don't own yet */
  private buildTarget(): string | null {
    const c = this.c
    for (const id of c.def.build) {
      const it = ITEM_MAP[id]
      if (c.hasItem(id)) continue
      // basic boots are superseded by upgraded boots
      if (it.unique === 'boots' && c.items.some(x => x && ITEM_MAP[x].unique === 'boots' && ITEM_MAP[x].price >= it.price)) continue
      // components already consumed into a finished item
      if (it.tags.includes('basic') && c.def.build.some(o => o !== id && c.hasItem(o) && ITEM_MAP[o].from?.includes(id))) continue
      return id
    }
    return null
  }

  /** what we would buy right now with `gold` (full item or a missing component) */
  nextPurchase(gold = this.c.gold): { id: string; cost: number } | null {
    const c = this.c
    const target = this.buildTarget()
    if (!target) return null
    const full = c.itemCost(target)
    if (full.cost <= gold) return { id: target, cost: full.cost }
    const it = ITEM_MAP[target]
    const have = [...c.items]
    for (const comp of it.from ?? []) {
      const idx = have.indexOf(comp)
      if (idx >= 0) { have[idx] = null; continue }
      const price = ITEM_MAP[comp].price
      if (price <= gold) return { id: comp, cost: price }
      return null
    }
    return null
  }

  private shop() {
    const c = this.c
    if (!c.canShop()) return
    if (!this.boughtStart) {
      this.boughtStart = true
      const first = c.def.build[0]
      c.buy(first)
      if (c.gold >= 50) c.buy('potion')
      if (c.gold >= 50) c.buy('potion')
    }
    for (let guard = 0; guard < 6; guard++) {
      const nx = this.nextPurchase()
      if (!nx) break
      if (c.items.indexOf(null) < 0 && !(ITEM_MAP[nx.id].from?.some(f => c.hasItem(f)))) {
        const pot = c.items.indexOf('potion')
        if (pot >= 0) c.sell(pot)
        else break
      }
      if (c.buy(nx.id)) break
    }
    // top up potions early on
    if (c.level < 9 && c.items.filter(x => x === 'potion').length < 1 && c.gold >= 50 && c.items.indexOf(null) >= 0) c.buy('potion')
  }

  private checkStuck() {
    const c = this.c
    if (c.moving && dist(c.x, c.z, this.lastPos[0], this.lastPos[1]) < 0.05) this.stuckT += this.interval
    else this.stuckT = 0
    this.lastPos = [c.x, c.z]
    if (this.stuckT > 1.5) {
      this.stuckT = 0
      c.cmdMove(c.x + (Math.random() - 0.5) * 6, c.z + (Math.random() - 0.5) * 6)
    }
  }

  // ------------------------------------------------------------------ helpers
  private enemies(r: number): Champion[] {
    const w = this.w, c = this.c
    return w.champs.filter(o => o.team !== c.team && !o.dead && w.canSee(c.team, o) && o.targetable() && dist(o.x, o.z, c.x, c.z) <= r)
  }
  private allies(r: number): Champion[] {
    const c = this.c
    return this.w.champs.filter(o => o.team === c.team && o !== c && !o.dead && dist(o.x, o.z, c.x, c.z) <= r)
  }
  private enemyTowerNear(x: number, z: number, pad = 1): Unit | null {
    for (const t of this.w.towers) {
      if (t.team === this.c.team || t.dead) continue
      if (dist(x, z, t.x, t.z) <= TOWER_RANGE + pad) return t
    }
    for (const n of this.w.structs) {
      if (n.team !== this.c.team && n.kind === 'nexus' && !n.dead && dist(x, z, n.x, n.z) < 7) return n
    }
    return null
  }
  private towerTanked(t: Unit) {
    const tgt = this.w.unit(t.targetId)
    if (tgt && tgt.kind === 'minion' && tgt.team === this.c.team) return true
    // allied minions under tower
    return this.w.near(t.x, t.z, TOWER_RANGE - 1).some(u => u.kind === 'minion' && u.team === this.c.team && !u.dead)
  }
  private goTo(x: number, z: number) {
    const c = this.c
    const o = c.order
    if (o && (o.t === 'move' || o.t === 'amove') && dist(o.x, o.z, x, z) < 1.5) return
    if (dist(c.x, c.z, x, z) < 0.8) return
    c.cmdMove(x, z)
  }
  private attack(u: Unit) {
    const c = this.c
    if (c.order?.t === 'attack' && c.order.id === u.id) return
    const ux = u.x, uz = u.z
    if (!c.validTarget(u)) { this.goTo(ux, uz); return }
    c.cmdAttack(u)
  }
  private predict(t: Unit, speed: number): P2 {
    const c = this.c
    const d = dist(c.x, c.z, t.x, t.z)
    const tt = speed > 0 ? d / speed : 0.4
    const k = this.c.diff >= 1 ? 1 : 0.4
    const e = this.aimErr
    return [t.x + t.vx * tt * k + (Math.random() - 0.5) * e, t.z + t.vz * tt * k + (Math.random() - 0.5) * e]
  }
  private fountain(): P2 {
    const f = this.w.map.fountains[this.c.team as 0 | 1]
    return [f.x, f.z]
  }

  // ------------------------------------------------------------------ decision making
  private decide() {
    const w = this.w, c = this.c
    const hp = c.hp / c.maxHp
    const foes = this.enemies(15)
    const friends = this.allies(15)
    const inBase = w.inFountain(c.team as 0 | 1, c.x, c.z, 8)

    // stay in base until healed
    if (inBase && (hp < 0.85 || c.mp < c.maxMp * 0.6) && foes.length === 0) { c.cmdStop(); return }

    // retreat logic
    const danger = foes.length > friends.length + 1 || (foes.length > 0 && hp < 0.35)
    if (hp < 0.22 || (danger && hp < 0.45)) this.retreating = true
    if (this.retreating && (hp > 0.7 || inBase)) this.retreating = false
    this.useConsumables(hp, foes)

    if (this.retreating) { this.retreat(foes); return }

    // recall to buy when rich and safe
    const buildT = this.buildTarget()
    const fullCost = buildT ? c.itemCost(buildT).cost : Infinity
    const canBuyBig = c.gold >= fullCost || (c.gold >= 1250 && !!this.nextPurchase())
    if (!inBase && foes.length === 0 && c.recallAt < 0 && w.now - c.lastDamaged > 4 &&
      (canBuyBig || c.mp < c.maxMp * 0.12 || hp < 0.45)) {
      c.cmdRecall()
      return
    }
    if (c.recallAt >= 0) {
      if (foes.some(f => dist(f.x, f.z, c.x, c.z) < 9)) c.cmdMove(...this.fountain())
      return
    }

    // fight
    const target = this.pickFightTarget(foes, friends, hp)
    if (target) { this.fight(target, foes); return }

    // support ally in fight
    this.supportSkills(friends)

    const grouping = w.map.laneIds.length > 1 && w.time > 15 * 60
    const obj = this.objective(friends, foes)
    if (obj) { this.attack(obj); return }
    if (this.role === 'jungle' && w.map.camps.length && !grouping) { this.jungle(foes); return }
    this.setLane(grouping ? 'mid' : this.baseLane)
    this.laning(foes)
  }

  /** the attackable enemy structure furthest forward on our lane (or the closest one overall) */
  private frontStructure(): Unit | null {
    const w = this.w, c = this.c
    let best: Unit | null = null, bs = Infinity
    for (const st of [...w.towers, ...w.structs]) {
      if (st.team === c.team || st.dead || w.isProtected(st)) continue
      const def = st.kind === 'tower' ? w.map.towers.find(d => d.id === st.id) : w.map.structs.find(d => d.id === st.id)
      const lane = def && 'lane' in def ? def.lane : undefined
      if (lane && lane !== 'base' && lane !== this.lane) continue
      const s = closestS(this.path, st.x, st.z) + dist(c.x, c.z, st.x, st.z) * 0.02
      if (s < bs) { bs = s; best = st }
    }
    return best
  }

  private setLane(l: LaneId) {
    if (l === this.lane || !this.w.map.lanes[l]) return
    this.lane = l
    const pts = this.w.map.lanes[l]!
    this.path = this.c.team === 0 ? pts : [...pts].reverse()
    this.pathLen = polylineLength(this.path)
  }

  /** take dragon / baron when the team is strong and nobody contests */
  private objective(friends: Champion[], foes: Champion[]): Unit | null {
    const w = this.w, c = this.c
    if (foes.length || c.hp / c.maxHp < 0.6 || w.time < 8 * 60) return null
    for (const u of w.units.values()) {
      if (!(u instanceof Monster) || u.dead || (u.mt !== 'dragon' && u.mt !== 'baron')) continue
      const d = dist(u.x, u.z, c.x, c.z)
      const need = u.mt === 'dragon' ? 9 : 13
      const helpers = friends.filter(f => dist(f.x, f.z, u.x, u.z) < 22).length
      const engaged = u.aggroId !== null && w.unit(u.aggroId)?.team === c.team
      if (c.level < need) continue
      if (engaged && d < 30) return u
      if (d < 40 && (helpers >= (u.mt === 'dragon' ? 1 : 2) || (this.role === 'jungle' && u.mt === 'dragon' && c.level >= 11))) return u
    }
    return null
  }

  private useConsumables(hp: number, foes: Champion[]) {
    const c = this.c
    if (hp < 0.55 && !c.hasBuff('regen')) {
      const idx = c.items.indexOf('potion')
      if (idx >= 0) c.tryCast((['1', '2', '3', '5', '6', '7'] as CastKey[])[idx], c.x, c.z)
    }
    if (hp < 0.3 && foes.length) {
      for (const k of ['D', 'F'] as CastKey[]) {
        const sp = c.spells[k === 'D' ? 0 : 1]
        if ((sp === 'heal' || sp === 'barrier') && c.canUse(k) === 'ok') { c.tryCast(k, c.x, c.z); break }
      }
      const zi = c.items.indexOf('zhonya')
      if (zi >= 0 && hp < 0.15 && foes.some(f => dist(f.x, f.z, c.x, c.z) < 5)) c.tryCast((['1', '2', '3', '5', '6', '7'] as CastKey[])[zi], c.x, c.z)
    }
  }

  private retreat(foes: Champion[]) {
    const c = this.c, w = this.w
    const [fx, fz] = this.fountain()
    const close = foes.filter(f => dist(f.x, f.z, c.x, c.z) < 7)
    if (close.length === 0 && w.now - c.lastDamaged > 2.5 && foes.length === 0 && !w.inFountain(c.team as 0 | 1, c.x, c.z, 8)) {
      if (c.recallAt < 0) c.cmdRecall()
      return
    }
    if (c.recallAt >= 0 && close.length === 0) return
    // escape tools
    if (close.length && c.hp / c.maxHp < 0.3) {
      const dx = fx - c.x, dz = fz - c.z
      const l = Math.hypot(dx, dz) || 1
      const ex = c.x + (dx / l) * 5, ez = c.z + (dz / l) * 5
      for (const k of SKILL_KEYS) {
        const def = c.castDef(k)
        if (!def || def.bot.use !== 'escape' || c.canUse(k) !== 'ok') continue
        if (c.tryCast(k, ex, ez) === 'ok') return
      }
      if (c.hp / c.maxHp < 0.15) {
        for (const k of ['D', 'F'] as CastKey[]) {
          if (c.spells[k === 'D' ? 0 : 1] === 'flash' && c.canUse(k) === 'ok') { c.tryCast(k, ex, ez); return }
          if (c.spells[k === 'D' ? 0 : 1] === 'ghost' && c.canUse(k) === 'ok') { c.tryCast(k, ex, ez); break }
        }
      }
    }
    // retreat along the lane toward base (paths go around walls)
    this.goTo(fx, fz)
  }

  private pickFightTarget(foes: Champion[], friends: Champion[], hp: number): Champion | null {
    const c = this.c
    if (!foes.length) return null
    let best: Champion | null = null, bs = -Infinity
    const myPow = hp * (1 + c.level * 0.1) * (1 + friends.filter(f => dist(f.x, f.z, c.x, c.z) < 10).length * 0.8)
    const enemyPow = foes.reduce((a, f) => a + (f.hp / f.maxHp) * (1 + f.level * 0.1), 0)
    const aggressive = c.diff >= 2 ? 1.0 : c.diff === 1 ? 1.15 : 1.35
    for (const f of foes) {
      const d = dist(f.x, f.z, c.x, c.z)
      if (d > c.stats.range + 6.5) continue
      const fhp = f.hp / f.maxHp
      const tower = this.enemyTowerNear(f.x, f.z, 0.5)
      if (tower && !this.towerTanked(tower) && !(fhp < 0.2 && hp > 0.6)) continue
      let s = (1 - fhp) * 3 - d * 0.15
      if (fhp < 0.3) s += 2
      if (s > bs) { bs = s; best = f }
    }
    if (!best) return null
    const fhp = best.hp / best.maxHp
    if (myPow < enemyPow * aggressive && fhp > 0.35) return null
    return best
  }

  private fight(t: Champion, foes: Champion[]) {
    const c = this.c
    this.castSkills(t, foes)
    if (c.casting || c.dash) return
    // summoner spells
    for (const k of ['D', 'F'] as CastKey[]) {
      const sp = c.spells[k === 'D' ? 0 : 1]
      if (sp === 'ignite' && t.hp / t.maxHp < 0.3 && dist(t.x, t.z, c.x, c.z) < 6 && c.canUse(k) === 'ok') c.tryCast(k, t.x, t.z, t.id)
      if (sp === 'ghost' && t.hp / t.maxHp < 0.25 && dist(t.x, t.z, c.x, c.z) > c.stats.range + 2 && c.canUse(k) === 'ok') c.tryCast(k, t.x, t.z)
    }
    this.attack(t)
  }

  private castSkills(t: Unit, foes: Unit[]) {
    const c = this.c
    const d = dist(c.x, c.z, t.x, t.z)
    const thp = t.hp / t.maxHp
    for (const k of ['R', 'Q', 'E', 'W'] as CastKey[]) {
      if (c.canUse(k) !== 'ok') continue
      const def = c.castDef(k)!
      if (Math.random() > this.skillChance) continue
      const range = def.bot.range ?? def.range
      const use = def.bot.use
      let ok = false
      if (k === 'R') {
        const nearCount = foes.filter(f => dist(f.x, f.z, t.x, t.z) < 4).length
        ok = thp < 0.55 || nearCount >= 2 || (use === 'engage' && thp < 0.8)
        if (use === 'global') ok = thp < 0.5
      } else ok = true
      if (!ok) continue
      switch (use) {
        case 'poke': case 'finisher': case 'engage': case 'global': case 'aoe': {
          if (use === 'finisher' && k !== 'R' && thp > 0.6 && t.isChamp) { /* still ok for basic skills */ }
          if (def.target === 'self') {
            if (d <= range + t.radius) { c.tryCast(k, c.x, c.z); return }
            break
          }
          if (d > range + t.radius) break
          if (def.target === 'unit') {
            if (def.champOnly && !t.isChamp) break
            c.tryCast(k, t.x, t.z, t.id)
            return
          }
          if (def.target === 'ally') break
          const speed = def.target === 'dir' ? 22 : 0
          const [px, pz] = this.predict(t, speed)
          if (c.tryCast(k, px, pz, t.id) === 'ok') return
          break
        }
        case 'buff':
          if (d < c.stats.range + 3.5) { c.tryCast(k, c.x, c.z); return }
          break
        case 'shield':
          if (c.hp / c.maxHp < 0.8 && foes.length) { c.tryCast(k, c.x, c.z, c.id); return }
          break
        case 'heal':
          if (c.hp / c.maxHp < 0.55) { c.tryCast(k, c.x, c.z, c.id); return }
          break
      }
    }
  }

  private supportSkills(friends: Champion[]) {
    const c = this.c
    for (const k of SKILL_KEYS) {
      if (c.canUse(k) !== 'ok') continue
      const def = c.castDef(k)!
      if (def.bot.use === 'heal' || def.bot.use === 'shield') {
        const all = [c, ...friends]
        const hurt = all.filter(a => a.hp / a.maxHp < (def.bot.use === 'heal' ? 0.6 : 0.5) && this.w.now - a.lastDamaged < 3 || a.hp / a.maxHp < 0.4)
        if (k === 'R') {
          const low = this.w.champs.filter(a => a.team === c.team && !a.dead && a.hp / a.maxHp < 0.35)
          if (low.length >= 1 && def.target === 'self') { c.tryCast(k, c.x, c.z); return }
          continue
        }
        const tgt = hurt.find(a => dist(a.x, a.z, c.x, c.z) <= def.range + 1)
        if (tgt) { c.tryCast(k, tgt.x, tgt.z, tgt.id); return }
      }
    }
  }

  // ------------------------------------------------------------------ laning
  private laneFront(): { ally: number; enemy: number } {
    const w = this.w, c = this.c
    let ally = -1, enemy = Infinity
    for (const u of w.units.values()) {
      if (!(u instanceof Minion) || u.dead || u.lane !== this.lane) continue
      const s = closestS(this.path, u.x, u.z)
      if (u.team === c.team) ally = Math.max(ally, s)
      else if (w.canSee(c.team, u)) enemy = Math.min(enemy, s)
    }
    return { ally, enemy }
  }

  private laning(foes: Champion[]) {
    const w = this.w, c = this.c
    const melee = c.def.melee
    // 1. never stand in an enemy tower's range while it is shooting at us
    for (const t of w.towers) {
      if (t.team === c.team || t.dead) continue
      if (t.targetId === c.id && dist(t.x, t.z, c.x, c.z) < TOWER_RANGE + 2.5) {
        const ts = closestS(this.path, t.x, t.z)
        const [bx, bz] = pointAlong(this.path, Math.max(8, ts - TOWER_RANGE - 3))
        c.cmdMove(bx, bz)
        return
      }
    }
    const reach = c.stats.range + 4
    const minions = w.near(c.x, c.z, reach).filter(u => u.kind === 'minion' && u.team !== c.team && !u.dead && w.canSee(c.team, u)) as Minion[]
    const alliedNear = w.near(c.x, c.z, 10).filter(u => u.kind === 'minion' && u.team === c.team && !u.dead).length
    const safeTarget = (m: Unit) => {
      const tw = this.enemyTowerNear(m.x, m.z, 0.5)
      if (tw && !(this.towerTanked(tw) && w.near(tw.x, tw.z, TOWER_RANGE).filter(u => u.kind === 'minion' && u.team === c.team && !u.dead).length >= 2)) return false
      return true
    }
    // 2. last hits
    const ad = c.stats.ad
    let lastHit: Unit | null = null
    for (const m of minions) {
      const est = estimate(m, { tgt: m.id, src: c.id, p: ad })
      const threshold = c.diff >= 1 ? est * 1.05 : est * 2
      if (m.hp <= threshold && (!lastHit || m.hp < lastHit.hp) && safeTarget(m)) lastHit = m
    }
    if (lastHit && (alliedNear > 0 || c.hp / c.maxHp > 0.5)) { this.attack(lastHit); return }
    // 3. poke enemy champions in lane
    if (foes.length && c.mp > c.maxMp * 0.35) {
      const f = foes.find(e => dist(e.x, e.z, c.x, c.z) < 11)
      if (f && !this.enemyTowerNear(c.x, c.z, 0) && !this.enemyTowerNear(f.x, f.z, 0)) {
        for (const k of ['Q', 'E', 'W'] as CastKey[]) {
          const def = c.castDef(k)
          if (!def || def.bot.use !== 'poke' || c.canUse(k) !== 'ok') continue
          if (dist(f.x, f.z, c.x, c.z) > (def.bot.range ?? def.range)) continue
          if (Math.random() > this.skillChance * 0.6) continue
          if (def.target === 'unit') { if (!def.champOnly || f.isChamp) c.tryCast(k, f.x, f.z, f.id) }
          else { const [px, pz] = this.predict(f, def.target === 'dir' ? 22 : 0); c.tryCast(k, px, pz) }
          return
        }
      }
    }
    // 4. push structures when our minions tank them
    for (const s of [...w.towers, ...w.structs]) {
      if (s.team === c.team || s.dead || w.isProtected(s)) continue
      if (dist(s.x, s.z, c.x, c.z) > 12) continue
      if (!this.towerTanked(s)) continue
      const need = foes.length === 0 ? 1 : 2
      if (s.kind === 'tower' && w.near(s.x, s.z, TOWER_RANGE).filter(u => u.kind === 'minion' && u.team === c.team && !u.dead).length < need) continue
      if (c.hp / c.maxHp > 0.35) { this.attack(s); return }
    }
    // 4b. siege: numbers advantage or dead enemies -> commit to structures
    const enemyTotal = w.champs.filter(o => o.team !== c.team).length
    const enemyAlive = w.champs.filter(o => o.team !== c.team && !o.dead).length
    const alliesHere = this.allies(12).length + 1
    const hpOk = c.hp / c.maxHp > 0.5
    const push = hpOk && (
      (foes.length === 0 && (alliesHere >= 2 || enemyAlive <= enemyTotal - 2 || w.time > 20 * 60)) ||
      alliesHere >= foes.length + 2)
    if (push) {
      const best = this.frontStructure()
      if (best) {
        const minionsUnder = w.near(best.x, best.z, TOWER_RANGE).filter(u => u.kind === 'minion' && u.team === c.team && !u.dead).length
        const tanked = best.kind !== 'tower' || minionsUnder >= 1 || alliesHere >= 3 || (best.targetId !== c.id && alliesHere >= 2)
        if (tanked) { this.attack(best); return }
        // wait just outside its range for our wave
        const bs = closestS(this.path, best.x, best.z)
        const [wx, wz] = pointAlong(this.path, Math.max(10, bs - TOWER_RANGE - 2.5))
        if (dist(c.x, c.z, best.x, best.z) > TOWER_RANGE + 2 || best.targetId === c.id) {
          if (!minions.length) { this.goTo(wx, wz); return }
        }
      }
    }
    // 5. farm the wave together with our minions
    if (minions.length && alliedNear > 0) {
      const m = [...minions].sort((a, b) => a.hp - b.hp).find(safeTarget)
      if (m) {
        if (minions.length >= 3 && c.mp > c.maxMp * 0.5 && Math.random() < 0.12) {
          for (const k of ['Q', 'W', 'E'] as CastKey[]) {
            const def = c.castDef(k)
            if (!def || (def.bot.use !== 'aoe' && def.bot.use !== 'poke') || c.canUse(k) !== 'ok' || def.target === 'ally' || def.champOnly) continue
            if (def.target === 'self' && dist(m.x, m.z, c.x, c.z) > (def.bot.range ?? 3)) continue
            if (dist(m.x, m.z, c.x, c.z) > def.range) continue
            if (c.tryCast(k, m.x, m.z, m.id) === 'ok') return
          }
        }
        const pushy = c.diff === 0 || this.role !== 'support'
        if (pushy || m.hp < ad * 3) { this.attack(m); return }
      }
    }
    // 6. positioning behind our wave, never inside an untanked tower
    const { ally, enemy } = this.laneFront()
    let s: number
    const back = melee ? 1.5 : 4
    const own = w.towers.filter(t => t.team === c.team && !t.dead && w.map.towers.find(d => d.id === t.id)!.lane === this.lane)
    let towerS = 18
    for (const t of own) towerS = Math.max(towerS, closestS(this.path, t.x, t.z))
    if (ally >= 0) s = ally - back - (this.role === 'support' ? 1.5 : 0)
    else s = towerS - 3
    if (push && foes.length === 0) s = Math.max(s, ally >= 0 ? ally + 1 : s)
    if (enemy < Infinity) s = Math.min(s, enemy - (melee ? 1.5 : c.stats.range + 0.5))
    if (ally < 0 && enemy < Infinity) s = Math.min(s, towerS - 1)
    s = Math.max(10, Math.min(this.pathLen - 12, s))
    let [px, pz] = pointAlong(this.path, s)
    const tower = this.enemyTowerNear(px, pz, 1.5)
    if (tower && !(this.towerTanked(tower) && w.near(tower.x, tower.z, TOWER_RANGE).filter(u => u.kind === 'minion' && u.team === c.team && !u.dead).length >= 2)) {
      const ts = closestS(this.path, tower.x, tower.z)
      ;[px, pz] = pointAlong(this.path, Math.max(10, ts - TOWER_RANGE - 3))
    }
    const side = this.role === 'support' ? 1.8 : this.role === 'bot' ? -1.2 : 0
    const [ax, az] = pointAlong(this.path, s + 0.5)
    const lx = -(az - pz), lz = ax - px
    const ll = Math.hypot(lx, lz) || 1
    this.goTo(px + (lx / ll) * side, pz + (lz / ll) * side)
  }

  // ------------------------------------------------------------------ jungle
  private jungle(foes: Champion[]) {
    const w = this.w, c = this.c
    // gank low enemies nearby
    const prey = foes.find(f => f.hp / f.maxHp < 0.5 && dist(f.x, f.z, c.x, c.z) < 14 && !this.enemyTowerNear(f.x, f.z))
    if (prey) { this.fight(prey, foes); return }
    const monsters = [...w.units.values()].filter(u => u instanceof Monster && !u.dead) as Monster[]
    // current camp still has monsters?
    let camp = this.jungleCamp
    if (camp && !monsters.some(m => m.camp === camp)) camp = null
    if (!monsters.length) {
      // before camps spawn: wait at our blue-side camp
      const first = w.map.camps.find(cp => cp.id === (c.team === 0 ? 'b-blue' : 'r-blue')) ?? w.map.camps[0]
      if (first) this.goTo(first.x + (c.team === 0 ? 3 : -3), first.z + (c.team === 0 ? 3 : -3))
      return
    }
    if (!camp) {
      const mySide = c.team === 0 ? 'b-' : 'r-'
      let best: string | null = null, bd = Infinity
      for (const m of monsters) {
        if (m.mt === 'baron' && c.level < 13) continue
        if (m.mt === 'dragon' && c.level < 9) continue
        if (m.resetting) continue
        const own = m.camp.startsWith(mySide)
        const d = dist(m.x, m.z, c.x, c.z) + (own ? 0 : 40)
        if (d < bd) { bd = d; best = m.camp }
      }
      camp = best
      this.jungleCamp = camp
    }
    if (!camp) { this.laning(foes); return }
    const targets = monsters.filter(m => m.camp === camp).sort((a, b) => a.hp - b.hp)
    const t = targets[0]
    if (!t) return
    if (c.hp / c.maxHp < 0.3 && t.hp / t.maxHp > 0.4) { this.retreating = true; return }
    // smite big monsters
    for (const k of ['D', 'F'] as CastKey[]) {
      if (c.spells[k === 'D' ? 0 : 1] !== 'smite' || c.canUse(k) !== 'ok') continue
      const big = targets.find(m => ['sentinel', 'brambleback', 'dragon', 'baron', 'gromp', 'krug', 'wolf', 'raptor'].includes(m.mt) && m.hp <= 390 + 20 * c.level && dist(m.x, m.z, c.x, c.z) < 5.5)
      if (big) { c.tryCast(k, big.x, big.z, big.id); return }
    }
    if (dist(t.x, t.z, c.x, c.z) < c.stats.range + 4 && c.mp > c.maxMp * 0.3) {
      for (const k of ['Q', 'W', 'E'] as CastKey[]) {
        const def = c.castDef(k)
        if (!def || c.canUse(k) !== 'ok' || def.champOnly || def.target === 'ally') continue
        if (def.bot.use === 'escape' || def.bot.use === 'heal' || def.bot.use === 'shield') continue
        if (Math.random() > 0.35) continue
        if (def.target === 'self' && def.bot.use !== 'buff' && dist(t.x, t.z, c.x, c.z) > (def.bot.range ?? 3)) continue
        if (c.tryCast(k, t.x, t.z, t.id) === 'ok') return
      }
    }
    this.attack(t)
  }
}

export function isBot(c: Champion) { return c.isBot }
export const unusedF = F
