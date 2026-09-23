export type Team = 0 | 1 | 2
export type UnitKind = 'champ' | 'minion' | 'tower' | 'inhib' | 'nexus' | 'monster' | 'ward'
export type SkillKey = 'Q' | 'W' | 'E' | 'R'
export type SpellKey = 'D' | 'F'
export type ItemKey = '1' | '2' | '3' | '5' | '6' | '7'
export type CastKey = SkillKey | SpellKey | ItemKey | '4' | 'B'

export const ITEM_KEYS: ItemKey[] = ['1', '2', '3', '5', '6', '7']
export const SKILL_KEYS: SkillKey[] = ['Q', 'W', 'E', 'R']

export interface Stats {
  maxHp: number
  hpRegen: number
  maxMp: number
  mpRegen: number
  ad: number
  ap: number
  armor: number
  mr: number
  as: number // attacks per second (final)
  asBonus: number // bonus attack speed fraction (items/buffs)
  range: number
  ms: number
  crit: number
  critDmg: number
  ls: number
  haste: number
  apen: number // % armor pen (0..1)
  mpen: number // flat magic pen
  apMult: number // % bonus ap
  heal: number // healing amp
}

export const emptyStats = (): Stats => ({
  maxHp: 0, hpRegen: 0, maxMp: 0, mpRegen: 0, ad: 0, ap: 0, armor: 0, mr: 0, as: 0, asBonus: 0,
  range: 0, ms: 0, crit: 0, critDmg: 0, ls: 0, haste: 0, apen: 0, mpen: 0, apMult: 0, heal: 0,
})

export function addStats(a: Stats, b: Partial<Stats>, k = 1) {
  for (const key in b) {
    const v = (b as any)[key]
    if (typeof v === 'number') (a as any)[key] += v * k
  }
  return a
}

/** replicated status bits */
export const F = {
  DEAD: 1,
  STUN: 2,
  ROOT: 4,
  SILENCE: 8,
  SLOW: 16,
  KNOCKUP: 32,
  STEALTH: 64,
  INVULN: 128,
  RECALL: 256,
  BURN: 512,
  HASTE: 1024,
  BLUE: 2048,
  RED: 4096,
  BARON: 8192,
  CAST: 16384,
  MOVE: 32768,
  RESET: 65536,
  SHIELD: 131072,
  STASIS: 262144,
  CHANNEL: 524288,
} as const

export interface CCSpec {
  k: 'stun' | 'root' | 'silence' | 'slow' | 'knockup' | 'burn' | 'knockback'
  d: number // duration
  a?: number // amount (slow %, burn total dmg, knockback dist)
  x?: number; z?: number // knockback origin
}

export interface HitPayload {
  tgt: string
  src: string
  p?: number // physical
  m?: number // magic
  t?: number // true
  apen?: number
  mpen?: number
  aa?: 1 // basic attack
  cr?: 1 // crit
  cc?: CCSpec[]
  sk?: string // skill id (for kill feed icon)
  mh?: number // bonus % max hp magic dmg (applied on target)
  ms?: number // bonus % missing hp true dmg (applied on target)
}

export type NetEvent =
  | { e: 'cast'; s: string; k: CastKey; id: string; l: number; x: number; z: number; tid?: string; ox: number; oz: number }
  | ({ e: 'hit' } & HitPayload)
  | { e: 'heal'; tgt: string; src: string; a: number }
  | { e: 'buff'; tgt: string; src: string; b: BuffSpec }
  | { e: 'death'; id: string; k: string; as: string[]; x: number; z: number; uk: UnitKind; ut: string; tm: Team; lv?: number; sk?: string; fb?: 1; b?: number }
  | { e: 'ward'; tm: Team; x: number; z: number; src: string }
  | { e: 'ping'; tm: Team; x: number; z: number; src: string; pk: number }
  | { e: 'end'; w: Team }
  | { e: 'relic'; id: string; by: string }
  | { e: 'chat'; tm: Team; n: string; t: string; all: 1 | 0 }
  | { e: 'lvl'; s: string; l: number }

export interface BuffSpec {
  kind: BuffKind
  dur: number
  value?: number
  stats?: Partial<Stats>
  key?: string
}

export type BuffKind =
  | 'stun' | 'root' | 'silence' | 'slow' | 'knockup' | 'stealth' | 'shield' | 'dr' | 'ms' | 'as' | 'burn' | 'stasis'
  | 'stat' | 'empower' | 'mark' | 'blue' | 'red' | 'baron' | 'dragon' | 'regen' | 'grievous' | 'spin' | 'recallbuff'
