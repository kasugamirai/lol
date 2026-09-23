import type { MonsterType } from '../mapdef'

export interface NpcDef {
  name: string
  hp: number
  ad: number
  armor: number
  mr: number
  as: number
  range: number
  ms: number
  radius: number
  gold: number
  xp: number
  windup: number
  proj: number // projectile speed, 0 = melee
  height: number
}

export type MinionType = 'melee' | 'caster' | 'siege' | 'super'
export const MINION_TYPES: MinionType[] = ['melee', 'caster', 'siege', 'super']

export const MINIONS: Record<MinionType, NpcDef> = {
  melee: { name: '近战小兵', hp: 450, ad: 14, armor: 0, mr: 0, as: 1.25, range: 1.2, ms: 4.8, radius: 0.5, gold: 21, xp: 60, windup: 0.22, proj: 0, height: 1.3 },
  caster: { name: '远程小兵', hp: 290, ad: 24, armor: 0, mr: 0, as: 0.667, range: 5.8, ms: 4.8, radius: 0.45, gold: 15, xp: 30, windup: 0.3, proj: 15, height: 1.3 },
  siege: { name: '炮车', hp: 880, ad: 42, armor: 20, mr: 0, as: 1.0, range: 7.2, ms: 4.8, radius: 0.85, gold: 60, xp: 93, windup: 0.3, proj: 17, height: 1.6 },
  super: { name: '超级兵', hp: 1600, ad: 180, armor: 30, mr: 30, as: 0.85, range: 1.5, ms: 4.8, radius: 0.95, gold: 60, xp: 97, windup: 0.25, proj: 0, height: 2.1 },
}

export const TOWERS: Record<1 | 2 | 3 | 4, { name: string; hp: number; ad: number; armor: number; mr: number }> = {
  1: { name: '外塔', hp: 2600, ad: 165, armor: 45, mr: 45 },
  2: { name: '内塔', hp: 2900, ad: 175, armor: 50, mr: 50 },
  3: { name: '高地塔', hp: 3100, ad: 185, armor: 55, mr: 55 },
  4: { name: '水晶塔', hp: 2800, ad: 160, armor: 55, mr: 55 },
}
export const TOWER_RANGE = 9.5
export const TOWER_AS = 0.83
export const TOWER_RADIUS = 1.4
export const TOWER_PROJ = 16

export const INHIB = { name: '水晶枢纽', hp: 2400, armor: 20, mr: 20, radius: 1.9, respawn: 180 }
export const NEXUS = { name: '星核', hp: 4200, armor: 0, mr: 0, radius: 3.2 }

export const MONSTERS: Record<MonsterType, NpcDef> = {
  gromp: { name: '魔沼蛙', hp: 1050, ad: 30, armor: 12, mr: 12, as: 0.6, range: 5.2, ms: 3.8, radius: 1.1, gold: 85, xp: 135, windup: 0.35, proj: 14, height: 2.2 },
  sentinel: { name: '蓝色哨兵', hp: 1350, ad: 36, armor: 16, mr: 16, as: 0.5, range: 1.8, ms: 3.8, radius: 1.4, gold: 100, xp: 160, windup: 0.4, proj: 0, height: 3.2 },
  wolf: { name: '暗影狼', hp: 800, ad: 22, armor: 10, mr: 0, as: 0.65, range: 1.4, ms: 4.4, radius: 0.9, gold: 60, xp: 90, windup: 0.25, proj: 0, height: 1.8 },
  wolfling: { name: '小狼', hp: 280, ad: 9, armor: 5, mr: 0, as: 0.65, range: 1.2, ms: 4.4, radius: 0.55, gold: 20, xp: 30, windup: 0.2, proj: 0, height: 1.3 },
  raptor: { name: '锋喙鸟', hp: 700, ad: 16, armor: 8, mr: 0, as: 0.7, range: 1.3, ms: 4.4, radius: 0.8, gold: 55, xp: 75, windup: 0.2, proj: 0, height: 1.8 },
  raptorling: { name: '小锋喙鸟', hp: 220, ad: 7, armor: 0, mr: 0, as: 0.7, range: 1.2, ms: 4.4, radius: 0.5, gold: 15, xp: 20, windup: 0.2, proj: 0, height: 1.2 },
  brambleback: { name: '红色荆棘兽', hp: 1350, ad: 38, armor: 16, mr: 16, as: 0.5, range: 1.8, ms: 3.8, radius: 1.4, gold: 100, xp: 160, windup: 0.4, proj: 0, height: 3.0 },
  krug: { name: '石甲虫', hp: 1050, ad: 32, armor: 26, mr: 10, as: 0.55, range: 1.6, ms: 3.6, radius: 1.2, gold: 70, xp: 110, windup: 0.35, proj: 0, height: 2.2 },
  krugling: { name: '小石甲虫', hp: 420, ad: 15, armor: 15, mr: 5, as: 0.6, range: 1.3, ms: 3.6, radius: 0.7, gold: 25, xp: 40, windup: 0.3, proj: 0, height: 1.4 },
  dragon: { name: '远古巨龙', hp: 3600, ad: 105, armor: 30, mr: 30, as: 0.5, range: 4.5, ms: 4.0, radius: 2.2, gold: 60, xp: 300, windup: 0.5, proj: 12, height: 4.5 },
  baron: { name: '纳什男爵', hp: 7200, ad: 165, armor: 60, mr: 60, as: 0.55, range: 6.0, ms: 0, radius: 3.0, gold: 300, xp: 600, windup: 0.5, proj: 14, height: 6 },
}

export const WARD = { hp: 3, vision: 9, dur: 90, radius: 0.35 }

export const XP_RANGE = 14
export const CHAMP_KILL_GOLD = 300
export const ASSIST_GOLD = 150
export const FIRST_BLOOD_GOLD = 100
export const TOWER_TEAM_GOLD = 150
export const TOWER_KILLER_GOLD = 100
export const INHIB_TEAM_GOLD = 50
export const PASSIVE_GOLD = 2.1 // per second
export const VISION = { champ: 13, minion: 8.5, tower: 13, ward: 9, monster: 4, nexus: 16, inhib: 8 }

export function xpToNext(level: number) {
  return 100 + level * 80
}
export function respawnTime(level: number, gameTime: number) {
  return 5 + level * 2.1 + Math.max(0, (gameTime - 900) / 60) * 0.8
}
export function champBounty(streak: number, deathStreak: number) {
  let g = CHAMP_KILL_GOLD
  if (streak >= 2) g += Math.min(500, (streak - 1) * 100)
  if (deathStreak >= 2) g = Math.max(100, g - (deathStreak - 1) * 50)
  return g
}
export function killXp(victimLevel: number) {
  return 120 + victimLevel * 38
}
