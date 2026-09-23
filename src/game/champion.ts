import { Unit } from './unit'
import type { World, SlotConfig } from './world'
import { CHAMP_MAP, ChampDef } from './data/champions'
import { ITEM_MAP, SELL_RATIO } from './data/items'
import { SPELL_MAP, ITEM_ACTIVES, WARD_SKILL } from './data/spells'
import { CastKey, F, ITEM_KEYS, SKILL_KEYS, HitPayload, addStats, emptyStats, Stats } from './types'
import { SkillDef, makeCtx, SKILLS } from './skills'
import { dealDamage, killUnit, isEnemyTarget, tickBuffs } from './combat'
import { xpToNext, respawnTime, PASSIVE_GOLD } from './data/units'
import { angleTo, clamp, dist, turnToward } from '../util/math'

export type Order =
  | { t: 'move'; x: number; z: number }
  | { t: 'attack'; id: string; auto?: boolean }
  | { t: 'amove'; x: number; z: number }
  | { t: 'cast'; key: CastKey; x: number; z: number; tid?: string }

export interface DashState {
  tx: number
  tz: number
  speed: number
  width: number
  onPass?: (u: Unit) => void
  onEnd?: () => void
  hit: Set<string>
  unstoppable: boolean
  filter: (u: Unit) => boolean
}

export type CastResult = 'ok' | 'moving' | 'dead' | 'none' | 'unlearned' | 'cooldown' | 'mana' | 'cc' | 'busy' | 'notarget' | 'nocharge'

export interface BotBrainLike {
  think(dt: number): void
}

const QWER_IDX: Record<string, number> = { Q: 0, W: 1, E: 2, R: 3 }

export class Champion extends Unit {
  def: ChampDef
  slot: string
  isBot: boolean
  pk: string
  level = 1
  xp = 0
  gold = 0
  goldTotal = 0
  items: (string | null)[] = [null, null, null, null, null, null]
  skillLv = [1, 1, 1, 1] // all skills learned by default
  cds: Record<string, number> = { Q: 0, W: 0, E: 0, R: 0, D: 0, F: 0, '4': 0, '1': 0, '2': 0, '3': 0, '5': 0, '6': 0, '7': 0 }
  cdMax: Record<string, number> = { Q: 1, W: 1, E: 1, R: 1, D: 1, F: 1, '4': 1, '1': 1, '2': 1, '3': 1, '5': 1, '6': 1, '7': 1 }
  spells: [string, string]
  wardCharges = 1
  wardRecharge = 60
  kills = 0
  deaths = 0
  assists = 0
  cs = 0
  streak = 0
  deathStreak = 0
  dmgToChamps = 0
  respawnAt = 0
  order: Order | null = null
  path: [number, number][] | null = null
  pathIdx = 0
  pathGoal: [number, number] | null = null
  repathAt = 0
  casting: { key: CastKey; sid: string; x: number; z: number; tid?: string; lvl: number; until: number } | null = null
  dash: DashState | null = null
  recallAt = -1
  recallDur = 8
  spellblade = false
  amoveDest: [number, number] | null = null
  idleSince = 0
  nextAcquire = 0
  brain: BotBrainLike | null = null
  diff = 1
  sunfireNext = 0
  respawnRemain = 0 // replicated for remote champions
  lastSeenAt = 0 // for minimap last-known

  constructor(public world: World, cfg: SlotConfig) {
    const def = CHAMP_MAP[cfg.champ] ?? CHAMP_MAP.blaze
    const sp = world.map.spawns[cfg.team][Number(cfg.slot.slice(1)) % 5]
    super(cfg.slot, 'champ', def.id, cfg.team, sp[0], sp[1], 0.65)
    this.def = def
    this.slot = cfg.slot
    this.isBot = cfg.bot
    this.pk = cfg.pk ?? ''
    this.name = cfg.name
    this.spells = cfg.spells
    this.diff = cfg.diff ?? 1
    this.height = 2.65
    this.facing = cfg.team === 0 ? Math.PI * 0.75 : -Math.PI * 0.25
    this.level = world.map.startLevel
    this.gold = world.map.startGold
    this.recalc()
    this.hp = this.maxHp
    this.mp = this.maxMp
  }

  /** every skill starts at rank 1; each level after 1 grants one upgrade point */
  get skillPoints() {
    return this.level - 1 - this.skillLv.reduce((a, b) => a + b - 1, 0)
  }

  hasItem(id: string) {
    return this.items.includes(id)
  }

  baseAd() {
    return this.def.base.ad + this.def.growth.ad * (this.level - 1)
  }

  recalc() {
    const d = this.def, b = d.base, g = d.growth, L = this.level - 1
    const s: Stats = emptyStats()
    s.maxHp = b.hp + g.hp * L
    s.hpRegen = b.hpRegen + g.hpRegen * L
    s.maxMp = b.mp + g.mp * L
    s.mpRegen = b.mpRegen + g.mpRegen * L
    s.ad = b.ad + g.ad * L
    s.armor = b.armor + g.armor * L
    s.mr = b.mr + g.mr * L
    s.asBonus = g.as * L
    s.range = b.range
    s.ms = b.ms
    s.critDmg = 0.75
    for (const it of this.items) if (it) addStats(s, ITEM_MAP[it]?.stats ?? {})
    for (const bf of this.buffs) {
      switch (bf.kind) {
        case 'stat': if (bf.stats) addStats(s, bf.stats); break
        case 'as': s.asBonus += bf.value; break
        case 'blue': s.haste += 15; s.mpRegen += 4; break
        case 'red': s.hpRegen += 4; break
        case 'baron': s.ad += 30; s.ap += 50; break
      }
    }
    s.ap *= 1 + s.apMult
    s.as = Math.min(2.5, b.as * (1 + s.asBonus))
    const prevMax = this.stats.maxHp
    this.stats = s
    if (prevMax > 0 && s.maxHp > prevMax && !this.dead && this.local) this.hp += s.maxHp - prevMax
    this.hp = Math.min(this.hp, s.maxHp)
    this.mp = Math.min(this.mp, s.maxMp)
  }

  // ------------------------------------------------------------------ update (owner only)
  update(dt: number) {
    const w = this.world
    this.brain?.think(dt)
    if (this.dead) {
      this.respawnRemain = Math.max(0, this.respawnAt - w.now)
      if (w.now >= this.respawnAt && w.winner === -1) this.respawn()
      this.fl = this.computeFlags()
      return
    }
    this.tickBuffs(dt)
    this.recalc()
    for (const k in this.cds) if (this.cds[k] > 0) this.cds[k] = Math.max(0, this.cds[k] - dt)
    if (this.wardCharges < 2) {
      this.wardRecharge -= dt
      if (this.wardRecharge <= 0) { this.wardCharges++; this.wardRecharge = 60 }
    }
    // regen
    let hpr = this.stats.hpRegen, mpr = this.stats.mpRegen
    const inFountain = w.inFountain(this.team as 0 | 1, this.x, this.z)
    if (inFountain) { hpr += this.maxHp * 0.15; mpr += this.maxMp * 0.15 }
    if (this.hasItem('warmog') && w.now - this.lastDamaged > 6) hpr += this.maxHp * 0.03
    this.hp = Math.min(this.maxHp, this.hp + hpr * dt)
    this.mp = Math.min(this.maxMp, this.mp + mpr * dt)
    if (w.time > 10 && w.winner === -1) { this.gold += PASSIVE_GOLD * dt; this.goldTotal += PASSIVE_GOLD * dt }
    // enemy fountain laser
    const enemy = (1 - this.team) as 0 | 1
    if (w.inFountain(enemy, this.x, this.z, 6)) {
      this.hp -= 600 * dt
      this.lastDamaged = w.now
      if (this.hp <= 0) { killUnit(w, this, w.nexusOf(enemy)?.id ?? ''); return }
    }
    // sunfire aura
    if (this.hasItem('sunfire') && w.now >= this.sunfireNext) {
      this.sunfireNext = w.now + 1
      for (const u of w.near(this.x, this.z, 3)) {
        if (isEnemyTarget(this, u)) dealDamage(w, this, u, { m: 18 + 0.015 * this.maxHp })
      }
    }
    // recall
    if (this.recallAt >= 0 && w.now - this.recallAt >= this.recallDur) {
      const sp = w.map.spawns[this.team as 0 | 1][Number(this.slot.slice(1)) % 5]
      this.x = sp[0]; this.z = sp[1]
      this.tp++
      this.recallAt = -1
      this.clearPath()
      this.order = null
      w.fx({ kind: 'flash', x: this.x, z: this.z, r: 1.6, color: 0x7ab8ff, dur: 0.6 })
      w.hooks.sound?.('recall', this.x, this.z)
    }
    // knockup visuals
    this.airY = this.hasBuff('knockup') ? Math.max(0, this.airY + (1.3 - this.airY) * Math.min(1, dt * 10)) : Math.max(0, this.airY - dt * 6)

    this.moving = false
    if (this.hasBuff('stasis')) { this.fl = this.computeFlags(); return }
    if (this.dash) {
      this.updateDash(dt)
      this.fl = this.computeFlags(F.MOVE)
      return
    }
    if (this.casting) {
      if (w.now >= this.casting.until) this.executeCast()
      else { this.fl = this.computeFlags(F.CAST); return }
    }
    if (this.windup > 0) {
      this.windup -= dt
      if (this.windup <= 0) this.fireAttack()
      else {
        const t = this.windupTarget
        if (t) this.facing = turnToward(this.facing, angleTo(this.x, this.z, t.x, t.z), dt * 20)
        this.fl = this.computeFlags()
        return
      }
    }
    this.atkCd -= dt
    if (this.recallAt < 0) this.processOrder(dt)
    let extra = 0
    if (this.recallAt >= 0) extra |= F.RECALL | F.CHANNEL
    if (this.moving) extra |= F.MOVE
    this.fl = this.computeFlags(extra)
  }

  private tickBuffs(dt: number) {
    const before = this.buffs.length
    if (tickBuffs(this.world, this, dt)) return
    if (before !== this.buffs.length) this.recalc()
  }

  // ------------------------------------------------------------------ orders & movement
  clearPath() {
    this.path = null
    this.pathIdx = 0
    this.pathGoal = null
  }

  private setPath(x: number, z: number) {
    const p = this.world.grid.findPath(this.x, this.z, x, z)
    this.path = p ?? []
    this.pathIdx = 0
    this.pathGoal = [x, z]
  }

  /** returns true when arrived */
  private moveToward(x: number, z: number, dt: number, chase: boolean): boolean {
    if (!this.canMove()) return false
    const w = this.world
    const g = this.pathGoal
    const need = !this.path || !g || (chase ? dist(g[0], g[1], x, z) > 1.0 && w.now >= this.repathAt : dist(g[0], g[1], x, z) > 0.3)
    if (need) {
      this.setPath(x, z)
      this.repathAt = w.now + 0.25
    }
    return this.followPath(dt)
  }

  private followPath(dt: number): boolean {
    const p = this.path
    if (!p || this.pathIdx >= p.length) return true
    let rem = this.moveSpeed() * dt
    let fx = 0, fz = 0
    while (rem > 0 && this.pathIdx < p.length) {
      const [px, pz] = p[this.pathIdx]
      const d = dist(this.x, this.z, px, pz)
      if (d > 1e-4) { fx = px - this.x; fz = pz - this.z }
      if (d <= rem) { this.x = px; this.z = pz; rem -= d; this.pathIdx++ }
      else { this.x += ((px - this.x) / d) * rem; this.z += ((pz - this.z) / d) * rem; rem = 0 }
    }
    if (fx || fz) this.facing = turnToward(this.facing, Math.atan2(fx, fz), dt * 22)
    this.moving = true
    return this.pathIdx >= p.length
  }

  validTarget(t: Unit | null): t is Unit {
    if (!t || t.dead || t.team === this.team || t.kind === 'ward' && false) return false
    if (!this.world.canSee(this.team, t)) return false
    if (!t.targetable()) return false
    if (t.isStructure && this.world.isProtected(t)) return false
    return true
  }

  inAtkRange(t: Unit, slack = 0) {
    return dist(this.x, this.z, t.x, t.z) <= this.stats.range + this.radius + t.radius + slack
  }

  private processOrder(dt: number) {
    const w = this.world
    const o = this.order
    if (!o) {
      if (w.now >= this.nextAcquire) { this.nextAcquire = w.now + 0.2; this.autoAcquire() }
      return
    }
    switch (o.t) {
      case 'move': {
        if (this.moveToward(o.x, o.z, dt, false)) this.order = null
        break
      }
      case 'amove': {
        const t = this.findNearestEnemy(Math.max(this.stats.range + 1.5, 5.5))
        if (t) {
          this.amoveDest = [o.x, o.z]
          this.order = { t: 'attack', id: t.id }
          this.attackStep(t, dt)
        } else if (this.moveToward(o.x, o.z, dt, false)) this.order = null
        break
      }
      case 'attack': {
        const t = w.unit(o.id)
        if (!this.validTarget(t)) {
          this.order = this.amoveDest ? { t: 'amove', x: this.amoveDest[0], z: this.amoveDest[1] } : null
          this.amoveDest = null
          this.clearPath()
          break
        }
        if (o.auto && !this.inAtkRange(t, 0.4)) { this.order = null; break }
        this.attackStep(t, dt)
        break
      }
      case 'cast': {
        const def = this.castDef(o.key)
        const t = o.tid ? w.unit(o.tid) : null
        if (!def || (o.tid && (!t || t.dead))) { this.order = null; break }
        const tx = t ? t.x : o.x, tz = t ? t.z : o.z
        const range = def.range + (t ? t.radius : 0)
        if (dist(this.x, this.z, tx, tz) <= range) {
          this.order = null
          this.clearPath()
          this.tryCast(o.key, tx, tz, o.tid, true)
        } else this.moveToward(tx, tz, dt, true)
        break
      }
    }
  }

  private attackStep(t: Unit, dt: number) {
    if (this.inAtkRange(t)) {
      this.clearPath()
      this.facing = turnToward(this.facing, angleTo(this.x, this.z, t.x, t.z), dt * 20)
      if (this.atkCd <= 0 && this.canAttack() && !this.hasBuff('spin')) this.startAttack(t)
    } else {
      this.moveToward(t.x, t.z, dt, true)
    }
  }

  findNearestEnemy(r: number, champsFirst = false): Unit | null {
    let best: Unit | null = null, bd = Infinity
    for (const u of this.world.near(this.x, this.z, r)) {
      if (!this.validTarget(u)) continue
      let d = dist(this.x, this.z, u.x, u.z) - u.radius
      if (champsFirst && u.isChamp) d -= 100
      if (d < bd) { bd = d; best = u }
    }
    return best
  }

  private autoAcquire() {
    if (this.isBot) return
    if (!this.canAttack() || this.moving) return
    const t = this.findNearestEnemy(this.stats.range + 0.3)
    if (t && this.inAtkRange(t)) this.order = { t: 'attack', id: t.id, auto: true }
  }

  private startAttack(t: Unit) {
    const w = this.world
    const as = this.stats.as
    this.windup = Math.max(0.08, this.def.windup / as)
    this.windupTarget = t
    this.atkCd = 1 / as
    this.atkSeq++
    this.animAtk = w.now
    this.targetId = t.id
    this.recallAt = -1
    if (this.hasBuff('stealth')) this.removeBuff('stealth')
    w.hooks.sound?.(this.def.melee ? 'swing' : 'shoot', this.x, this.z)
  }

  private fireAttack() {
    const w = this.world
    const t = this.windupTarget
    this.windupTarget = null
    if (!t || t.dead) return
    let p = this.stats.ad, m = 0
    const crit = Math.random() < this.stats.crit
    if (crit) p *= 1 + this.stats.critDmg
    const cc: NonNullable<HitPayload['cc']> = []
    const emp = this.buffs.find(b => b.kind === 'empower')
    if (emp) {
      if (emp.key === 'shadeE') { p += emp.value; cc.push({ k: 'slow', d: 1, a: 0.4 }) }
      else if (emp.key === 'thunderWe') { m += emp.value; cc.push({ k: 'stun', d: 0.8 }) }
      this.removeBuff(emp.key)
      w.fx({ kind: 'hitspark', x: t.x, z: t.z, r: 1.4, color: this.def.color, dur: 0.4 })
    }
    if (this.spellblade) { p += this.baseAd(); this.spellblade = false }
    if (this.hasItem('rageblade')) m += 15 + 0.1 * this.stats.ap
    if (this.hasBuff('red')) cc.push({ k: 'slow', d: 1.5, a: 0.15 }, { k: 'burn', d: 3, a: 10 + 3 * this.level })
    const spec = { p, m, cc: cc.length ? cc : undefined, aa: true, cr: crit }
    if (this.def.melee) {
      dealDamage(w, this, t, spec)
      w.fx({ kind: 'slash', x: t.x, z: t.z, r: 1, dir: this.facing, color: crit ? 0xffa030 : 0xffffff, dur: 0.25 })
      w.hooks.sound?.('hit', t.x, t.z)
    } else {
      w.spawnProjectile({
        srcId: this.id, src: this, team: this.team, x: this.x, z: this.z, y: 1.3, dx: 0, dz: 0,
        speed: this.def.proj, homing: t, maxDist: 999, width: 0.2, pierce: 1, auth: true,
        vis: crit ? { ...this.def.projVis, size: this.def.projVis.size * 1.6 } : this.def.projVis,
        filter: () => false,
        onHit: tt => { dealDamage(w, this, tt, spec); w.hooks.sound?.('hit', tt.x, tt.z) },
      })
    }
  }

  interrupt(force = false) {
    this.casting = null
    this.windup = 0
    this.windupTarget = null
    this.recallAt = -1
    if (this.dash && (!this.dash.unstoppable || force)) this.dash = null
  }

  startDash(d: DashState) {
    this.dash = d
    this.windup = 0
    this.recallAt = -1
    this.clearPath()
  }

  private updateDash(dt: number) {
    const d = this.dash!
    const w = this.world
    const dd = dist(this.x, this.z, d.tx, d.tz)
    const step = d.speed * dt
    if (dd > 1e-4) this.facing = Math.atan2(d.tx - this.x, d.tz - this.z)
    if (dd <= step) { this.x = d.tx; this.z = d.tz }
    else { this.x += ((d.tx - this.x) / dd) * step; this.z += ((d.tz - this.z) / dd) * step }
    if (d.onPass) {
      for (const u of w.near(this.x, this.z, d.width + 1)) {
        if (d.hit.has(u.id) || !d.filter(u)) continue
        if (dist(this.x, this.z, u.x, u.z) <= d.width + u.radius) { d.hit.add(u.id); d.onPass(u) }
      }
    }
    this.moving = true
    if (dd <= step) {
      this.dash = null
      d.onEnd?.()
    }
  }

  // ------------------------------------------------------------------ casting
  castDef(key: CastKey): SkillDef | null {
    if (key in QWER_IDX) return this.def.skills[QWER_IDX[key]]
    if (key === 'D') return SPELL_MAP[this.spells[0]]?.skill ?? null
    if (key === 'F') return SPELL_MAP[this.spells[1]]?.skill ?? null
    if (key === '4') return WARD_SKILL
    const idx = ITEM_KEYS.indexOf(key as any)
    if (idx >= 0) {
      const it = this.items[idx]
      return it ? ITEM_ACTIVES[it] ?? null : null
    }
    return null
  }
  castLevel(key: CastKey) {
    if (key in QWER_IDX) return this.skillLv[QWER_IDX[key]]
    return this.level
  }
  castCost(key: CastKey) {
    const def = this.castDef(key)
    if (!def) return 0
    const l = this.castLevel(key)
    return def.cost[Math.max(0, Math.min(def.cost.length - 1, l - 1))] ?? 0
  }

  /** check castability; returns reason */
  canUse(key: CastKey): CastResult {
    if (this.dead) return 'dead'
    const def = this.castDef(key)
    if (!def) return 'none'
    if (this.castLevel(key) <= 0) return 'unlearned'
    if (this.cds[key] > 0) return 'cooldown'
    if (this.mp < this.castCost(key)) return 'mana'
    if (key === '4' && this.wardCharges <= 0) return 'nocharge'
    const isItem = ITEM_KEYS.includes(key as any)
    if (isItem ? !!(this.fl & (F.STUN | F.KNOCKUP)) && key !== 'D' : !this.canCast()) {
      if (!(def.id === 'spell.cleanse' || def.id === 'item.zhonya') || this.has(F.STASIS)) return 'cc'
    }
    if (this.casting || this.dash) return 'busy'
    return 'ok'
  }

  tryCast(key: CastKey, x: number, z: number, tid?: string, fromOrder = false): CastResult {
    const w = this.world
    const r = this.canUse(key)
    if (r !== 'ok') return r
    const def = this.castDef(key)!
    switch (def.target) {
      case 'self':
        this.beginCast(key, def, this.x, this.z)
        return 'ok'
      case 'dir': {
        let dx = x - this.x, dz = z - this.z
        const l = Math.hypot(dx, dz)
        if (l < 0.05) { dx = Math.sin(this.facing); dz = Math.cos(this.facing) } else { dx /= l; dz /= l }
        this.beginCast(key, def, this.x + dx * def.range, this.z + dz * def.range)
        return 'ok'
      }
      case 'point': {
        let px = x, pz = z
        if (!def.noClamp) {
          const d = dist(this.x, this.z, x, z)
          if (d > def.range) { px = this.x + ((x - this.x) / d) * def.range; pz = this.z + ((z - this.z) / d) * def.range }
        }
        this.beginCast(key, def, px, pz)
        return 'ok'
      }
      case 'unit':
      case 'ally': {
        let t = w.unit(tid)
        const ok = (u: Unit | null): u is Unit => {
          if (!u || u.dead || !u.targetable()) return false
          if (u.isStructure || u.kind === 'ward') return false
          if (def.champOnly && !u.isChamp) return false
          const team = def.unitTeam ?? (def.target === 'ally' ? 'ally' : 'enemy')
          if (team === 'enemy' && u.team === this.team) return false
          if (team === 'ally' && u.team !== this.team) return false
          if (u === this && def.target !== 'ally') return false
          if (u.team !== this.team && !w.canSee(this.team, u)) return false
          return true
        }
        if (!ok(t)) {
          if (def.selfCast) t = this
          else return 'notarget'
        }
        const range = def.range + t.radius
        if (t !== this && dist(this.x, this.z, t.x, t.z) > range) {
          if (fromOrder) return 'notarget'
          this.order = { t: 'cast', key, x: t.x, z: t.z, tid: t.id }
          this.recallAt = -1
          return 'moving'
        }
        this.beginCast(key, def, t.x, t.z, t === this ? undefined : t.id)
        return 'ok'
      }
    }
  }

  private beginCast(key: CastKey, def: SkillDef, x: number, z: number, tid?: string) {
    const w = this.world
    const lvl = this.castLevel(key)
    this.mp -= this.castCost(key)
    const isSkill = key in QWER_IDX
    const cdBase = def.cd[Math.max(0, Math.min(def.cd.length - 1, lvl - 1))] ?? 0
    const cd = isSkill ? cdBase * (100 / (100 + this.stats.haste)) : cdBase
    this.cds[key] = cd
    this.cdMax[key] = Math.max(0.1, cd)
    const idx = ITEM_KEYS.indexOf(key as any)
    if (idx >= 0 && this.items[idx] && ITEM_MAP[this.items[idx]!]?.consumable) this.items[idx] = null
    if (key === '4') { if (this.wardCharges === 2) this.wardRecharge = 60; this.wardCharges-- }
    if (isSkill && this.hasItem('trinity')) this.spellblade = true
    if (def.id !== 'shade.W' && this.hasBuff('stealth')) this.removeBuff('stealth')
    this.recallAt = -1
    this.windup = 0
    this.windupTarget = null
    if (def.target !== 'self' && (x !== this.x || z !== this.z)) this.facing = angleTo(this.x, this.z, x, z)
    this.casting = { key, sid: def.id, x, z, tid, lvl, until: w.now + def.castTime }
    this.animCast = w.now
    this.animCastKey = key
    if (isSkill || key === 'R') this.clearPath()
    w.emit({ e: 'cast', s: this.id, k: key, id: def.id, l: lvl, x: +x.toFixed(2), z: +z.toFixed(2), tid, ox: +this.x.toFixed(2), oz: +this.z.toFixed(2) })
    if (def.castTime <= 0) this.executeCast()
  }

  private executeCast() {
    const c = this.casting
    this.casting = null
    if (!c) return
    const def = SKILLS.get(c.sid)
    if (!def) return
    const ctx = makeCtx(this.world, this, c.sid, c.key, c.lvl, c.x, c.z, c.tid, true)
    def.cast(ctx)
    // keep moving towards the previous destination after casting
    if (this.order?.t === 'move') this.pathGoal = null
  }

  // ------------------------------------------------------------------ commands
  cmdMove(x: number, z: number) {
    if (this.dead) return
    this.order = { t: 'move', x, z }
    this.amoveDest = null
    this.recallAt = -1
    if (this.windup > 0) { this.windup = 0; this.windupTarget = null; this.atkCd = Math.max(this.atkCd, 0) }
    this.setPath(x, z)
  }
  cmdAttack(u: Unit) {
    if (this.dead) return
    if (!this.validTarget(u)) return
    if (this.order?.t === 'attack' && this.order.id === u.id && !this.order.auto) return
    this.order = { t: 'attack', id: u.id }
    this.amoveDest = null
    this.recallAt = -1
  }
  cmdAttackMove(x: number, z: number) {
    if (this.dead) return
    this.order = { t: 'amove', x, z }
    this.recallAt = -1
    this.setPath(x, z)
  }
  cmdStop() {
    this.order = null
    this.amoveDest = null
    this.clearPath()
    if (this.windup > 0) { this.windup = 0; this.windupTarget = null }
  }
  cmdRecall() {
    const w = this.world
    if (this.dead || this.casting || this.dash || this.recallAt >= 0) return
    if (w.inFountain(this.team as 0 | 1, this.x, this.z)) return
    this.recallAt = w.now
    this.recallDur = this.hasBuff('baron') ? 4 : 8
    this.order = null
    this.clearPath()
    this.windup = 0
    w.hooks.sound?.('recallstart', this.x, this.z)
  }

  levelSkill(i: number): boolean {
    if (this.skillPoints <= 0) return false
    if (!canUpgradeSkill(this.level, this.skillLv[i], i)) return false
    this.skillLv[i]++
    return true
  }

  canShop() {
    return this.dead || this.world.inShop(this.team as 0 | 1, this.x, this.z)
  }

  /** effective price after owned components, and the inventory slots that would be consumed */
  itemCost(id: string): { cost: number; consume: number[] } {
    const it = ITEM_MAP[id]
    if (!it) return { cost: Infinity, consume: [] }
    let cost = it.price
    const consume: number[] = []
    for (const comp of it.from ?? []) {
      const idx = this.items.findIndex((x, i) => x === comp && !consume.includes(i))
      if (idx >= 0) { consume.push(idx); cost -= ITEM_MAP[comp].price }
    }
    return { cost: Math.max(0, cost), consume }
  }

  buy(id: string): string | null {
    const it = ITEM_MAP[id]
    if (!it) return '未知物品'
    if (!this.canShop()) return '只能在泉水或阵亡时购买'
    const { cost, consume } = this.itemCost(id)
    if (this.gold < cost) return '金币不足'
    if (it.unique) {
      const clash = this.items.findIndex((x, i) => x && ITEM_MAP[x]?.unique === it.unique && !consume.includes(i))
      if (clash >= 0) return '已拥有同类装备'
    }
    if (!it.consumable && !it.from && this.items.includes(id) && it.tags.includes('boots')) return '已拥有同类装备'
    const items = this.items.map((x, i) => (consume.includes(i) ? null : x))
    const slot = items.indexOf(null)
    if (slot < 0) return '装备栏已满'
    items[slot] = id
    this.items = items
    this.gold -= cost
    this.recalc()
    return null
  }

  sell(slot: number): string | null {
    const id = this.items[slot]
    if (!id) return '空栏位'
    if (!this.canShop()) return '只能在泉水或阵亡时出售'
    this.gold += Math.floor(ITEM_MAP[id].price * SELL_RATIO)
    this.items[slot] = null
    this.recalc()
    return null
  }

  // ------------------------------------------------------------------ progression
  addGold(g: number, show = true) {
    this.gold += g
    this.goldTotal += g
    if (show && this === this.world.me && g >= 1) {
      this.world.float(this.x, this.z, `+${Math.round(g)}`, '#ffd24a', 14, 3)
      this.world.hooks.sound?.('gold')
    }
  }
  addXp(x: number) {
    if (this.level >= 18) return
    this.xp += x
    while (this.level < 18 && this.xp >= xpToNext(this.level)) {
      this.xp -= xpToNext(this.level)
      this.levelUp()
    }
  }
  levelUp() {
    const w = this.world
    const oldMax = this.maxHp, oldMp = this.maxMp
    this.level++
    this.recalc()
    this.hp += Math.max(0, this.maxHp - oldMax)
    this.mp += Math.max(0, this.maxMp - oldMp)
    w.fx({ kind: 'levelup', x: this.x, z: this.z, r: 1.2, color: 0xffd76a, dur: 1.2, follow: this })
    w.emit({ e: 'lvl', s: this.id, l: this.level })
    if (this === w.me) w.hooks.sound?.('levelup')
  }

  onDamaged(src: Unit | null, h: HitPayload) {
    if (this.recallAt >= 0 && src && src.team !== this.team) {
      this.recallAt = -1
    }
  }

  onDeath(killerId: string) {
    const w = this.world
    this.deaths++
    this.deathStreak++
    this.streak = 0
    this.respawnAt = w.now + respawnTime(this.level, w.time)
    this.respawnRemain = this.respawnAt - w.now
    this.order = null
    this.clearPath()
    this.casting = null
    this.dash = null
    this.recallAt = -1
    this.buffs = this.buffs.filter(b => b.kind === 'dragon')
    this.damagers.clear()
    if (this === w.me) w.hooks.sound?.('death')
  }

  respawn() {
    const w = this.world
    const sp = w.map.spawns[this.team as 0 | 1][Number(this.slot.slice(1)) % 5]
    this.dead = false
    this.x = sp[0]; this.z = sp[1]
    this.tp++
    this.recalc()
    this.hp = this.maxHp
    this.mp = this.maxMp
    this.airY = 0
    this.facing = this.team === 0 ? Math.PI * 0.75 : -Math.PI * 0.25
    w.fx({ kind: 'flash', x: this.x, z: this.z, r: 1.6, color: 0x9ad0ff, dur: 0.7 })
  }

  /** apply the saved/replicated state when taking over this champion */
  restore(s: Partial<ChampSave>) {
    if (s.lv) this.level = s.lv
    if (s.xp !== undefined) this.xp = s.xp
    if (s.g !== undefined) this.gold = s.g
    if (s.it) this.items = s.it.slice(0, 6).concat([null, null, null, null, null, null]).slice(0, 6)
    if (s.sk) this.skillLv = s.sk.slice(0, 4)
    if (s.k !== undefined) this.kills = s.k
    if (s.d !== undefined) this.deaths = s.d
    if (s.a !== undefined) this.assists = s.a
    if (s.cs !== undefined) this.cs = s.cs
    this.recalc()
  }
}

export interface ChampSave {
  lv: number
  xp: number
  g: number
  it: (string | null)[]
  sk: number[]
  k: number
  d: number
  a: number
  cs: number
}

export function clampHp(u: Unit) {
  u.hp = clamp(u.hp, 0, u.maxHp)
}

/** rank limits: basic skills up to 1 + floor(level/2) (max 5); ultimate rank 2 at 11, rank 3 at 16 */
export function canUpgradeSkill(level: number, cur: number, i: number) {
  if (i === 3) return cur < 3 && level >= (cur === 1 ? 11 : 16)
  return cur < 5 && cur + 1 <= 1 + Math.floor(level / 2)
}
