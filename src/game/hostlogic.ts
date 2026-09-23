import type { World } from './world'
import { Unit } from './unit'
import { Minion, Monster, Ward, towerUpdate } from './npc'
import { MinionType, INHIB } from './data/units'
import { Champion } from './champion'
import { killUnit } from './combat'
import { LaneId, CampDef } from './mapdef'
import { Team } from './types'
import { dist, pointAlong } from '../util/math'
import { BotBrain } from './ai/bot'

export class HostLogic {
  nextId = 1
  wave = 0
  nextWaveAt = 15
  campAt = new Map<string, number>() // game time when camp spawns (-1 = alive)
  inhibAt = new Map<string, number>()
  relicAt: number[] = []
  towerSt = new Map<string, { chain: number; chainTarget: string; nextScan: number }>()
  afk = new Set<string>()
  private pendingSpawns: { at: number; team: 0 | 1; lane: LaneId; mt: MinionType }[] = []

  constructor(public w: World) {
    for (const c of w.map.camps) this.campAt.set(c.id, c.first)
    this.relicAt = w.map.relics.map(() => 0)
  }

  towerState(u: Unit) {
    let s = this.towerSt.get(u.id)
    if (!s) this.towerSt.set(u.id, (s = { chain: 0, chainTarget: '', nextScan: 0 }))
    return s
  }

  /** champions controlled by the host: bots and disconnected players */
  hostControlled(c: Champion) {
    return c.isBot || this.afk.has(c.slot)
  }

  syncBots() {
    const w = this.w
    for (const c of w.champs) {
      if (c === w.me) continue
      const mine = w.isHost && this.hostControlled(c)
      if (mine && !c.local) {
        c.local = true
        c.brain = new BotBrain(w, c)
        c.clearPath()
        c.order = null
      } else if (!mine && c.local) {
        c.local = false
        c.brain = null
      } else if (mine && !c.brain) c.brain = new BotBrain(w, c)
    }
  }

  update(dt: number) {
    const w = this.w
    if (w.winner === -1) {
      if (w.time >= this.nextWaveAt) {
        this.queueWave()
        this.nextWaveAt += 30
      }
      if (this.pendingSpawns.length) {
        const due = this.pendingSpawns.filter(p => p.at <= w.time)
        if (due.length) {
          this.pendingSpawns = this.pendingSpawns.filter(p => p.at > w.time)
          for (const p of due) this.spawnMinion(p.team, p.lane, p.mt)
        }
      }
      for (const c of w.map.camps) {
        const at = this.campAt.get(c.id) ?? -1
        if (at >= 0 && w.time >= at) this.spawnCamp(c)
      }
      for (const [id, at] of this.inhibAt) {
        if (w.time >= at) {
          const u = w.unit(id)
          if (u) { u.dead = false; u.hp = u.maxHp }
          this.inhibAt.delete(id)
          w.hooks.announce?.(u && u.team === w.myTeam ? '我方水晶枢纽已重生' : '敌方水晶枢纽已重生')
        }
      }
      this.updateRelics()
    }
    const remove: Unit[] = []
    for (const u of w.units.values()) {
      if (!u.local || u.kind === 'champ') continue
      if (u instanceof Minion) u.update(w, dt)
      else if (u instanceof Monster) u.update(w, dt)
      else if (u.kind === 'tower') { if (w.winner === -1) towerUpdate(w, u, dt, this.towerState(u)) }
      else if (u instanceof Ward) { if (!u.dead && w.now >= u.expires) killUnit(w, u, '') }
      if (u.dead && (u.kind === 'minion' || u.kind === 'monster' || u.kind === 'ward') && w.now - u.deadAt > 1.6) remove.push(u)
    }
    for (const u of remove) w.removeUnit(u)
  }

  private queueWave() {
    const w = this.w
    this.wave++
    const t = w.time
    for (const team of [0, 1] as const) {
      for (const lane of w.map.laneIds) {
        let k = 0
        const add = (mt: MinionType) => this.pendingSpawns.push({ at: t + k++ * 0.85, team, lane, mt })
        const enemyInhib = w.structs.find(s => s.kind === 'inhib' && s.team !== team && s.type === lane)
        const superWave = enemyInhib?.dead
        for (let i = 0; i < 3; i++) add('melee')
        if (superWave) add('super')
        else if (this.wave % 3 === 0) add('siege')
        for (let i = 0; i < 3; i++) add('caster')
      }
    }
  }

  spawnMinion(team: 0 | 1, lane: LaneId, mt: MinionType) {
    const w = this.w
    const pts = w.map.lanes[lane]!
    const L = pts.length
    const s = w.map.minionSpawnS
    const len = pts.reduce((a, p, i) => i ? a + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0, 0)
    const [x, z] = pointAlong(pts, team === 0 ? s : len - s)
    const m = new Minion('m' + this.nextId++, mt, team, lane, pts, x + (Math.random() - 0.5), z + (Math.random() - 0.5), this.wave)
    m.local = true
    w.addUnit(m)
    void L
    return m
  }

  spawnCamp(c: CampDef) {
    const w = this.w
    this.campAt.set(c.id, -1)
    c.monsters.forEach((md, i) => {
      const m = new Monster(`j${this.nextId++}`, md.type, c.id, c.x + md.dx, c.z + md.dz, c.face, w.time, !!c.epic)
      m.local = true
      w.addUnit(m)
    })
    if (c.epic) w.hooks.announce?.(`${c.name}已经出现！`, undefined, '#c89bff')
  }

  spawnWard(team: Team, x: number, z: number) {
    const w = this.w
    const mine = [...w.units.values()].filter(u => u instanceof Ward && u.team === team && !u.dead) as Ward[]
    if (mine.length >= 6) {
      mine.sort((a, b) => a.expires - b.expires)
      killUnit(w, mine[0], '')
    }
    const wd = new Ward('w' + this.nextId++, team, x, z, w.now)
    wd.local = true
    w.addUnit(wd)
  }

  takeRelic(_id: string, _by: string) { /* relics are detected host side */ }

  private updateRelics() {
    const w = this.w
    w.map.relics.forEach((r, i) => {
      if (this.relicAt[i] > w.time) { w.relicsUp[i] = false; return }
      w.relicsUp[i] = true
      for (const c of w.champs) {
        if (c.dead || dist(c.x, c.z, r[0], r[1]) > 1.5) continue
        const amt = 120 + c.level * 12
        if (c.local) w.healUnit(c, amt, true)
        else w.emit({ e: 'heal', tgt: c.id, src: 'relic', a: amt })
        w.fx({ kind: 'heal', x: r[0], z: r[1], r: 1.5, color: 0x6aff9a, dur: 0.8 })
        this.relicAt[i] = w.time + 40
        w.relicsUp[i] = false
        break
      }
    })
  }

  onDamaged(u: Unit, src: Unit | null) {
    if (u instanceof Monster) {
      u.aggro(this.w, src)
      // the whole camp joins the fight
      for (const o of this.w.units.values()) {
        if (o instanceof Monster && o !== u && o.camp === u.camp && !o.dead && !o.aggroId) o.aggro(this.w, src)
      }
    }
  }

  onDeath(u: Unit, killerId: string) {
    const w = this.w
    if (u instanceof Monster) {
      const alive = [...w.units.values()].some(o => o instanceof Monster && o.camp === u.camp && !o.dead)
      if (!alive) {
        const c = w.map.camps.find(c => c.id === u.camp)
        if (c) this.campAt.set(c.id, w.time + c.respawn)
      }
    } else if (u.kind === 'inhib') {
      this.inhibAt.set(u.id, w.time + INHIB.respawn)
    } else if (u.kind === 'nexus') {
      const winner = (1 - u.team) as Team
      w.emit({ e: 'end', w: winner })
      w.setWinner(winner)
    }
  }
}
