import type { Stats } from '../types'

export type ItemTag = 'ad' | 'ap' | 'as' | 'crit' | 'tank' | 'mana' | 'boots' | 'support' | 'consumable' | 'basic'

export interface ItemDef {
  id: string
  name: string
  icon: string
  price: number
  stats: Partial<Stats>
  tags: ItemTag[]
  passive?: string
  active?: { name: string; cd: number; desc: string }
  consumable?: boolean
  unique?: string // unique group (e.g. boots)
  from?: string[] // components consumed when crafting
}

const I = (d: ItemDef) => d

export const ITEMS: ItemDef[] = [
  I({ id: 'potion', name: '生命药水', icon: '🧪', price: 50, stats: {}, tags: ['consumable'], consumable: true, active: { name: '饮用', cd: 1, desc: '在12秒内回复150生命值' } }),
  I({ id: 'long_sword', name: '长剑', icon: '🗡️', price: 350, stats: { ad: 10 }, tags: ['ad', 'basic'] }),
  I({ id: 'amp_tome', name: '增幅典籍', icon: '📘', price: 400, stats: { ap: 20 }, tags: ['ap', 'basic'] }),
  I({ id: 'ruby', name: '红水晶', icon: '🔴', price: 400, stats: { maxHp: 150 }, tags: ['tank', 'basic'] }),
  I({ id: 'cloth', name: '布甲', icon: '🦺', price: 300, stats: { armor: 15 }, tags: ['tank', 'basic'] }),
  I({ id: 'mantle', name: '抗魔斗篷', icon: '🧣', price: 450, stats: { mr: 25 }, tags: ['tank', 'basic'] }),
  I({ id: 'dagger', name: '短剑', icon: '🔪', price: 300, stats: { asBonus: 0.15 }, tags: ['as', 'basic'] }),
  I({ id: 'sapphire', name: '蓝水晶', icon: '🔷', price: 350, stats: { maxMp: 250 }, tags: ['mana', 'basic'] }),
  I({ id: 'cloak', name: '灵巧披风', icon: '🧥', price: 550, stats: { crit: 0.15 }, tags: ['crit', 'basic'] }),
  I({ id: 'boots', name: '速度之靴', icon: '👟', price: 300, stats: { ms: 0.35 }, tags: ['boots', 'basic'], unique: 'boots' }),

  I({ id: 'zeal_boots', name: '狂战士胫甲', icon: '🥾', price: 1000, stats: { ms: 0.6, asBonus: 0.3 }, from: ['boots', 'dagger'], tags: ['boots', 'as'], unique: 'boots' }),
  I({ id: 'sorc_boots', name: '法师之靴', icon: '🪄', price: 1000, stats: { ms: 0.6, mpen: 15 }, from: ['boots', 'amp_tome'], tags: ['boots', 'ap'], unique: 'boots' }),
  I({ id: 'plated_boots', name: '铁板靴', icon: '🛡️', price: 1000, stats: { ms: 0.6, armor: 22 }, from: ['boots', 'cloth'], tags: ['boots', 'tank'], unique: 'boots', passive: '受到的普攻伤害降低12%' }),

  I({ id: 'dawn_blade', name: '破晓之刃', icon: '⚔️', price: 3300, stats: { ad: 65, crit: 0.25, critDmg: 0.35 }, from: ['long_sword', 'long_sword', 'cloak'], tags: ['ad', 'crit'], passive: '暴击伤害提升35%' }),
  I({ id: 'bloodthirster', name: '饮血魔剑', icon: '🩸', price: 3200, stats: { ad: 55, ls: 0.18 }, from: ['long_sword', 'long_sword', 'dagger'], tags: ['ad'] }),
  I({ id: 'trinity', name: '三相之力', icon: '🔱', price: 3300, stats: { ad: 35, asBonus: 0.3, maxHp: 300, haste: 20 }, from: ['long_sword', 'dagger', 'ruby', 'sapphire'], tags: ['ad', 'as'], passive: '咒刃：施放技能后下一次普攻额外造成100%基础攻击力伤害' }),
  I({ id: 'storm_bow', name: '疾风之弓', icon: '🏹', price: 2800, stats: { asBonus: 0.4, crit: 0.2, ms: 0.3 }, from: ['dagger', 'dagger', 'cloak'], tags: ['as', 'crit'] }),
  I({ id: 'cleaver', name: '黑色切割者', icon: '🪓', price: 3100, stats: { ad: 40, maxHp: 400, haste: 20, apen: 0.25 }, from: ['long_sword', 'ruby', 'long_sword'], tags: ['ad', 'tank'], passive: '25%护甲穿透' }),
  I({ id: 'rageblade', name: '鬼索之怒', icon: '🌀', price: 2900, stats: { ad: 30, ap: 30, asBonus: 0.35 }, from: ['dagger', 'amp_tome', 'long_sword'], tags: ['as', 'ap', 'ad'], passive: '普攻附带15+10%法强魔法伤害' }),

  I({ id: 'deathcap', name: '灭世法冠', icon: '👑', price: 3600, stats: { ap: 120, apMult: 0.3 }, from: ['amp_tome', 'amp_tome', 'amp_tome'], tags: ['ap'], passive: '法术强度提升30%' }),
  I({ id: 'luden', name: '回响法典', icon: '📕', price: 3000, stats: { ap: 90, maxMp: 600, haste: 20 }, from: ['amp_tome', 'sapphire', 'amp_tome'], tags: ['ap', 'mana'] }),
  I({ id: 'zhonya', name: '时光沙漏', icon: '⏳', price: 3000, stats: { ap: 80, armor: 45 }, from: ['amp_tome', 'cloth', 'amp_tome'], tags: ['ap', 'tank'], active: { name: '凝滞', cd: 120, desc: '进入2.5秒凝滞状态：无敌但无法行动' } }),
  I({ id: 'void_staff', name: '虚空法杖', icon: '🔮', price: 2800, stats: { ap: 70, mpen: 25 }, from: ['amp_tome', 'amp_tome', 'mantle'], tags: ['ap'], passive: '25点法术穿透' }),

  I({ id: 'sunfire', name: '日炎圣盾', icon: '☀️', price: 2800, stats: { maxHp: 450, armor: 40 }, from: ['ruby', 'cloth', 'ruby'], tags: ['tank'], passive: '献祭：每秒对附近敌人造成18+1.5%最大生命值的魔法伤害' }),
  I({ id: 'visage', name: '振奋盔甲', icon: '💚', price: 2800, stats: { maxHp: 450, mr: 55, haste: 10, hpRegen: 2, heal: 0.25 }, from: ['ruby', 'mantle', 'ruby'], tags: ['tank'], passive: '受到的治疗效果提升25%' }),
  I({ id: 'thornmail', name: '荆棘之甲', icon: '🌵', price: 2700, stats: { maxHp: 350, armor: 70 }, from: ['cloth', 'cloth', 'ruby'], tags: ['tank'], passive: '被普攻时反弹10+10%护甲的魔法伤害' }),
  I({ id: 'warmog', name: '狂徒铠甲', icon: '💪', price: 3000, stats: { maxHp: 800, hpRegen: 4 }, from: ['ruby', 'ruby', 'ruby'], tags: ['tank'], passive: '6秒未受伤害后每秒回复3%最大生命值' }),
  I({ id: 'redemption', name: '救赎', icon: '✨', price: 2300, stats: { maxHp: 250, haste: 20, ap: 40, mpRegen: 1.5 }, from: ['ruby', 'amp_tome', 'sapphire'], tags: ['support', 'ap'], active: { name: '救赎之光', cd: 90, desc: '治疗自身及6码内友军 180+12×等级 生命值' } }),
]

export const ITEM_MAP: Record<string, ItemDef> = Object.fromEntries(ITEMS.map(i => [i.id, i]))
export const SELL_RATIO = 0.7

export function statLine(s: Partial<Stats>): string {
  const parts: string[] = []
  const p = (k: keyof Stats, label: string, f: (v: number) => string = v => `+${v}`) => { const v = s[k]; if (v) parts.push(`${f(v)} ${label}`) }
  p('ad', '攻击力'); p('ap', '法术强度'); p('maxHp', '生命值'); p('maxMp', '法力值'); p('armor', '护甲'); p('mr', '魔抗')
  p('asBonus', '攻击速度', v => `+${Math.round(v * 100)}%`); p('crit', '暴击率', v => `+${Math.round(v * 100)}%`)
  p('ms', '移动速度', v => `+${Math.round(v * 70)}`); p('ls', '生命偷取', v => `+${Math.round(v * 100)}%`)
  p('haste', '技能急速'); p('apen', '护甲穿透', v => `+${Math.round(v * 100)}%`); p('mpen', '法术穿透')
  p('hpRegen', '生命回复/秒'); p('mpRegen', '法力回复/秒'); p('apMult', '法强加成', v => `+${Math.round(v * 100)}%`)
  p('critDmg', '暴击伤害', v => `+${Math.round(v * 100)}%`); p('heal', '治疗效果', v => `+${Math.round(v * 100)}%`)
  return parts.join('，')
}
