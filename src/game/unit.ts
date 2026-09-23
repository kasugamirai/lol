import { Interp } from './interp'
import { BuffKind, BuffSpec, F, Stats, Team, UnitKind, emptyStats } from './types'

export interface Buff {
  key: string
  kind: BuffKind
  until: number
  value: number
  src?: string
  stats?: Partial<Stats>
  next?: number
  data?: any
}

let seq = 1
export const nextLocalId = () => seq++

export class Unit {
  x = 0
  z = 0
  facing = 0
  airY = 0
  hp = 1
  mp = 0
  stats: Stats = emptyStats()
  dead = false
  deadAt = 0
  local = false
  buffs: Buff[] = []
  fl = 0 // current flags (computed for local units, replicated for remote)
  // combat state
  targetId: string | null = null
  atkCd = 0
  windup = 0
  windupTarget: Unit | null = null
  atkSeq = 0
  seenAtkSeq = 0
  // animation
  animAtk = -99
  animCast = -99
  animCastKey = ''
  moving = false
  speedNow = 0
  tp = 0
  interp = new Interp()
  damagers = new Map<string, number>()
  lastDamaged = -99
  lastAttackedChamp = -99 // last time this unit attacked an enemy champion (tower aggro / call for help)
  lastAttackedChampTarget = ''
  vis: [boolean, boolean] = [true, true]
  name = ''
  removeAt = 0
  bountyGold = 0
  bountyXp = 0
  height = 1.8
  shieldR = 0 // replicated shield amount (remote units)
  vx = 0
  vz = 0
  px = NaN
  pz = NaN

  constructor(
    public id: string,
    public kind: UnitKind,
    public type: string,
    public team: Team,
    x: number,
    z: number,
    public radius: number,
  ) {
    this.x = x
    this.z = z
  }

  get isChamp() { return this.kind === 'champ' }
  get isStructure() { return this.kind === 'tower' || this.kind === 'inhib' || this.kind === 'nexus' }
  get maxHp() { return this.stats.maxHp }
  get maxMp() { return this.stats.maxMp }

  has(flag: number) { return (this.fl & flag) !== 0 }

  // ---------- buffs (owner side) ----------
  addBuff(now: number, spec: BuffSpec, src?: string) {
    if (this.dead) return
    if (this.has(F.STASIS) && spec.kind !== 'stasis') return
    const key = spec.key ?? (['stun', 'root', 'silence', 'knockup', 'stasis', 'stealth', 'blue', 'red', 'baron', 'grievous', 'recallbuff'].includes(spec.kind) ? spec.kind : `${spec.kind}:${src ?? ''}`)
    const until = now + spec.dur
    const ex = this.buffs.find(b => b.key === key)
    if (ex) {
      if (spec.kind === 'shield') { ex.value = Math.max(ex.value, spec.value ?? 0); ex.until = until }
      else if (spec.kind === 'dragon') { ex.value += spec.value ?? 1; ex.until = until }
      else { ex.until = Math.max(ex.until, until); ex.value = spec.value ?? ex.value; if (spec.stats) ex.stats = spec.stats }
      return ex
    }
    const b: Buff = { key, kind: spec.kind, until, value: spec.value ?? 0, src, stats: spec.stats }
    if (spec.kind === 'burn') b.next = now + 0.5
    this.buffs.push(b)
    return b
  }

  removeBuff(keyOrKind: string) {
    this.buffs = this.buffs.filter(b => b.key !== keyOrKind && b.kind !== keyOrKind)
  }

  hasBuff(kind: BuffKind) {
    for (const b of this.buffs) if (b.kind === kind) return true
    return false
  }
  getBuff(kind: BuffKind) {
    return this.buffs.find(b => b.kind === kind)
  }

  slowAmount() {
    let s = 0
    for (const b of this.buffs) if (b.kind === 'slow' && b.value > s) s = b.value
    return s
  }
  sumBuff(kind: BuffKind) {
    let s = 0
    for (const b of this.buffs) if (b.kind === kind) s += b.value
    return s
  }
  shieldTotal() {
    return this.local ? this.sumBuff('shield') : this.shieldR
  }
  damageReduction() {
    let m = 1
    for (const b of this.buffs) if (b.kind === 'dr') m *= 1 - b.value
    return 1 - m
  }

  computeFlags(extra = 0) {
    let f = extra
    if (this.dead) f |= F.DEAD
    for (const b of this.buffs) {
      switch (b.kind) {
        case 'stun': f |= F.STUN; break
        case 'root': f |= F.ROOT; break
        case 'silence': f |= F.SILENCE; break
        case 'slow': f |= F.SLOW; break
        case 'knockup': f |= F.KNOCKUP; break
        case 'stealth': f |= F.STEALTH; break
        case 'stasis': f |= F.STASIS | F.INVULN; break
        case 'burn': f |= F.BURN; break
        case 'ms': if (b.value > 0) f |= F.HASTE; break
        case 'blue': f |= F.BLUE; break
        case 'red': f |= F.RED; break
        case 'baron': f |= F.BARON; break
        case 'shield': if (b.value > 0) f |= F.SHIELD; break
      }
    }
    return f
  }

  canMove() { return !this.dead && !(this.fl & (F.STUN | F.ROOT | F.KNOCKUP | F.STASIS)) }
  canAttack() { return !this.dead && !(this.fl & (F.STUN | F.KNOCKUP | F.STASIS)) }
  canCast() { return !this.dead && !(this.fl & (F.STUN | F.SILENCE | F.KNOCKUP | F.STASIS)) }
  targetable() { return !this.dead && !(this.fl & (F.INVULN | F.STASIS)) }

  moveSpeed() {
    let ms = this.stats.ms * (1 + this.sumBuff('ms'))
    ms *= 1 - this.slowAmount()
    return Math.max(1.2, ms)
  }
}
