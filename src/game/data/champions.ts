import { registerSkill } from '../skillreg'
import {
  SkillDef, lv, skillshot, dmg, dashTo, buffSelf, buffUnit, aoeCircle, aoeLine, homing, zone, blinkTo,
  enemiesInCircle, healTarget, CastCtx,
} from '../skills'
import type { ProjVis } from '../world'
import { F } from '../types'
import type { Champion } from '../champion'
import { angleTo } from '../../util/math'

export type ModelKind = 'blade' | 'archer' | 'mage' | 'golem' | 'assassin' | 'frost' | 'lancer' | 'ember'

export interface ChampDef {
  id: string
  name: string
  title: string
  role: string
  color: number
  color2: number
  model: ModelKind
  melee: boolean
  windup: number
  proj: number
  projVis: ProjVis
  base: { hp: number; hpRegen: number; mp: number; mpRegen: number; ad: number; armor: number; mr: number; as: number; range: number; ms: number }
  growth: { hp: number; hpRegen: number; mp: number; mpRegen: number; ad: number; armor: number; mr: number; as: number }
  skills: SkillDef[]
  build: string[]
  diff: number
  lore: string
}

const pct = (v: number) => `${Math.round(v * 100)}%`
const n = (arr: number[], l: number) => Math.round(lv(arr, Math.max(1, l)))
const AD = (c: { stats: { ad: number } }) => c.stats.ad
const AP = (c: { stats: { ap: number } }) => c.stats.ap

function S(d: SkillDef) { return registerSkill(d) }

// -------------------------------------------------------------- 烈刃
const blaze: ChampDef = {
  id: 'blaze', name: '烈刃', title: '炽炎剑豪', role: '战士', color: 0xff7a2f, color2: 0x5a2a14, model: 'blade',
  melee: true, windup: 0.28, proj: 0, projVis: { kind: 'bolt', color: 0xff8a3a, size: 0.3 },
  base: { hp: 650, hpRegen: 1.7, mp: 280, mpRegen: 1.4, ad: 66, armor: 36, mr: 32, as: 0.66, range: 1.35, ms: 4.65 },
  growth: { hp: 105, hpRegen: 0.16, mp: 40, mpRegen: 0.1, ad: 3.6, armor: 4.6, mr: 2.05, as: 0.025 },
  diff: 1, lore: '来自熔岩山脉的剑客，挥剑时会带起灼热的气浪。',
  build: ['boots', 'long_sword', 'plated_boots', 'trinity', 'cleaver', 'sunfire', 'visage', 'thornmail'],
  skills: [
    S({
      id: 'blaze.Q', name: '疾风斩', icon: '💨', maxLv: 5, cost: [40, 40, 40, 40, 40], cd: [9, 8.5, 8, 7.5, 7], range: 5.5,
      target: 'dir', castTime: 0, ind: { t: 'line', w: 1.2 }, bot: { use: 'engage', range: 5.5 },
      desc: (l, c) => `向指定方向突进5.5码，对路径上的敌人造成 ${n([60, 90, 120, 150, 180], l)} (+90%攻击力) 物理伤害。`,
      cast: ctx => {
        const tx = ctx.ox + ctx.dx * 5.5, tz = ctx.oz + ctx.dz * 5.5
        dashTo(ctx, {
          x: tx, z: tz, speed: 24, width: 1.2, color: 0xff8a3a,
          onPass: t => dmg(ctx, t, { p: lv([60, 90, 120, 150, 180], ctx.lvl) + 0.9 * AD(ctx.c) }),
        })
        ctx.w.hooks.sound?.('dash', ctx.ox, ctx.oz)
      },
    }),
    S({
      id: 'blaze.W', name: '钢铁意志', icon: '🛡️', maxLv: 5, cost: [50, 50, 50, 50, 50], cd: [16, 15, 14, 13, 12], range: 0,
      target: 'self', castTime: 0, ind: { t: 'none' }, bot: { use: 'buff' },
      desc: (l, c) => `获得 ${n([70, 110, 150, 190, 230], l)} (+12%最大生命) 点护盾，持续2.5秒，并提升30%移速1.5秒。`,
      cast: ctx => {
        ctx.w.fx({ kind: 'shieldfx', x: ctx.ox, z: ctx.oz, r: 1.3, color: 0xffb347, dur: 2.5, follow: ctx.c })
        buffSelf(ctx, { kind: 'shield', dur: 2.5, value: lv([70, 110, 150, 190, 230], ctx.lvl) + 0.12 * ctx.c.maxHp, key: 'blazeW' })
        buffSelf(ctx, { kind: 'ms', dur: 1.5, value: 0.3, key: 'blazeWms' })
        ctx.w.hooks.sound?.('shield', ctx.ox, ctx.oz)
      },
    }),
    S({
      id: 'blaze.E', name: '剑刃风暴', icon: '🌪️', maxLv: 5, cost: [50, 50, 50, 50, 50], cd: [10, 9.5, 9, 8.5, 8], range: 3,
      target: 'self', castTime: 0, ind: { t: 'circle', r: 3 }, bot: { use: 'aoe', range: 3 },
      desc: (l, c) => `旋转2.5秒，每0.5秒对周围3码的敌人造成 ${n([18, 26, 34, 42, 50], l)} (+35%攻击力) 物理伤害，期间移速+15%。`,
      cast: ctx => {
        const c = ctx.c
        ctx.w.fx({ kind: 'spin', x: ctx.ox, z: ctx.oz, r: 3, color: 0xff7a2f, dur: 2.5, follow: c })
        buffSelf(ctx, { kind: 'spin', dur: 2.5, key: 'spin' })
        buffSelf(ctx, { kind: 'ms', dur: 2.5, value: 0.15, key: 'blazeEms' })
        if (!ctx.auth) return
        for (let i = 1; i <= 5; i++) {
          ctx.w.after(i * 0.5, () => {
            if (c.dead) return
            for (const t of enemiesInCircle(ctx, c.x, c.z, 3)) dmg(ctx, t, { p: lv([18, 26, 34, 42, 50], ctx.lvl) + 0.35 * AD(c) })
          })
        }
      },
    }),
    S({
      id: 'blaze.R', name: '断罪', icon: '⚔️', maxLv: 3, cost: [100, 100, 100], cd: [100, 85, 70], range: 4.5,
      target: 'unit', unitTeam: 'enemy', champOnly: true, castTime: 0.3, ind: { t: 'range' }, bot: { use: 'finisher', range: 4.5 },
      desc: (l, c) => `召唤巨剑斩击目标英雄，造成 ${n([150, 250, 350], l)} + 目标已损失生命值${pct(lv([0.28, 0.32, 0.36], l))}的真实伤害。`,
      cast: ctx => {
        const t = ctx.target
        if (!t) return
        ctx.w.fx({ kind: 'pillar', x: t.x, z: t.z, r: 1.6, color: 0xffc04a, dur: 0.8, follow: t })
        ctx.w.hooks.sound?.('ult', t.x, t.z)
        dmg(ctx, t, { t: lv([150, 250, 350], ctx.lvl), ms: lv([0.28, 0.32, 0.36], ctx.lvl) })
      },
    }),
  ],
}

// -------------------------------------------------------------- 风语者
const arrowVis: ProjVis = { kind: 'arrow', color: 0x9dffb0, size: 0.5, trail: true }
const wind: ChampDef = {
  id: 'wind', name: '风语者', title: '疾风游侠', role: '射手', color: 0x4fd67a, color2: 0x1d4a2c, model: 'archer',
  melee: false, windup: 0.22, proj: 26, projVis: { kind: 'arrow', color: 0xc8ffd0, size: 0.4 },
  base: { hp: 575, hpRegen: 1.2, mp: 320, mpRegen: 1.4, ad: 60, armor: 26, mr: 30, as: 0.66, range: 6.2, ms: 4.45 },
  growth: { hp: 92, hpRegen: 0.11, mp: 42, mpRegen: 0.09, ad: 3.1, armor: 4.2, mr: 1.3, as: 0.03 },
  diff: 2, lore: '在森林中长大的神射手，风会为她的箭指引方向。',
  build: ['boots', 'dagger', 'zeal_boots', 'dawn_blade', 'storm_bow', 'bloodthirster', 'rageblade', 'mantle'],
  skills: [
    S({
      id: 'wind.Q', name: '穿云箭', icon: '🏹', maxLv: 5, cost: [40, 40, 40, 40, 40], cd: [6, 5.5, 5, 4.5, 4], range: 11.5,
      target: 'dir', castTime: 0.22, ind: { t: 'line', w: 0.9 }, bot: { use: 'poke', range: 11 },
      desc: (l, c) => `射出一支利箭，对命中的第一个敌人造成 ${n([30, 60, 90, 120, 150], l)} (+125%攻击力) 物理伤害。命中后其他技能冷却减少1.5秒。`,
      cast: ctx => {
        ctx.w.hooks.sound?.('shoot', ctx.ox, ctx.oz)
        skillshot(ctx, {
          range: 11.5, speed: 32, width: 0.45, vis: { kind: 'arrow', color: 0x7dffa0, size: 0.9, trail: true },
          onHit: t => {
            dmg(ctx, t, { p: lv([30, 60, 90, 120, 150], ctx.lvl) + 1.25 * AD(ctx.c) })
            if (ctx.ch) { ctx.ch.cds.W = Math.max(0, ctx.ch.cds.W - 1.5); ctx.ch.cds.E = Math.max(0, ctx.ch.cds.E - 1.5) }
          },
        })
      },
    }),
    S({
      id: 'wind.W', name: '暴风箭雨', icon: '🎯', maxLv: 5, cost: [60, 60, 60, 60, 60], cd: [12, 10.5, 9, 7.5, 6], range: 8.5,
      target: 'dir', castTime: 0.22, ind: { t: 'cone', r: 8.5, a: 0.44 }, bot: { use: 'poke', range: 8 },
      desc: (l, c) => `扇形射出7支箭，每支对命中的敌人造成 ${n([40, 60, 80, 100, 120], l)} (+85%攻击力) 物理伤害并减速25%，持续2秒。`,
      cast: ctx => {
        ctx.w.hooks.sound?.('shoot', ctx.ox, ctx.oz)
        const hitIds = new Set<string>()
        const base = Math.atan2(ctx.dx, ctx.dz)
        for (let i = -3; i <= 3; i++) {
          const a = base + i * 0.145
          skillshot(ctx, {
            range: 8.5, speed: 26, width: 0.3, dx: Math.sin(a), dz: Math.cos(a), vis: arrowVis, hitIds,
            onHit: t => dmg(ctx, t, { p: lv([40, 60, 80, 100, 120], ctx.lvl) + 0.85 * AD(ctx.c), cc: [{ k: 'slow', d: 2, a: 0.25 }] }),
          })
        }
      },
    }),
    S({
      id: 'wind.E', name: '疾步', icon: '🍃', maxLv: 5, cost: [45, 45, 45, 45, 45], cd: [14, 13, 12, 11, 10], range: 4.5,
      target: 'dir', castTime: 0, ind: { t: 'line', w: 0.8 }, bot: { use: 'escape', range: 4.5 },
      desc: (l, c) => `向指定方向冲刺4.5码，之后3秒内攻击速度提升 ${n([30, 40, 50, 60, 70], l)}%。`,
      cast: ctx => {
        dashTo(ctx, { x: ctx.ox + ctx.dx * 4.5, z: ctx.oz + ctx.dz * 4.5, speed: 26, color: 0x7dffa0 })
        buffSelf(ctx, { kind: 'as', dur: 3, value: lv([0.3, 0.4, 0.5, 0.6, 0.7], ctx.lvl), key: 'windE' })
        ctx.w.hooks.sound?.('dash', ctx.ox, ctx.oz)
      },
    }),
    S({
      id: 'wind.R', name: '苍鹰之矢', icon: '🦅', maxLv: 3, cost: [100, 100, 100], cd: [90, 75, 60], range: 45,
      target: 'dir', castTime: 0.3, ind: { t: 'line', w: 1.6 }, bot: { use: 'global', range: 28 },
      desc: (l, c) => `射出一支横穿地图的巨箭，命中第一个敌方英雄，造成 ${n([200, 325, 450], l)} (+100%法强 +60%攻击力) 魔法伤害，并根据飞行距离眩晕1~3秒。`,
      cast: ctx => {
        ctx.w.hooks.sound?.('ult', ctx.ox, ctx.oz)
        skillshot(ctx, {
          range: 45, speed: 17, width: 0.8, champsOnly: true, vis: { kind: 'arrow', color: 0x7dfff0, size: 2.2, trail: true },
          onHit: (t, p) => dmg(ctx, t, {
            m: lv([200, 325, 450], ctx.lvl) + AP(ctx.c) + 0.6 * AD(ctx.c),
            cc: [{ k: 'stun', d: Math.min(3, 1 + p.traveled / 12) }],
          }),
        })
      },
    }),
  ],
}

// -------------------------------------------------------------- 星咏
const star: ChampDef = {
  id: 'star', name: '星咏', title: '星辰歌者', role: '法师', color: 0xb36bff, color2: 0x3a1c5c, model: 'mage',
  melee: false, windup: 0.25, proj: 20, projVis: { kind: 'orb', color: 0xd4a8ff, size: 0.35 },
  base: { hp: 545, hpRegen: 1.1, mp: 420, mpRegen: 1.8, ad: 52, armor: 21, mr: 30, as: 0.62, range: 6.0, ms: 4.4 },
  growth: { hp: 90, hpRegen: 0.11, mp: 52, mpRegen: 0.12, ad: 3, armor: 4.4, mr: 1.3, as: 0.02 },
  diff: 2, lore: '能听见星辰低语的少女，她的歌声能让群星坠落。',
  build: ['boots', 'amp_tome', 'sorc_boots', 'luden', 'deathcap', 'zhonya', 'void_staff', 'visage'],
  skills: [
    S({
      id: 'star.Q', name: '星缚', icon: '✨', maxLv: 5, cost: [50, 55, 60, 65, 70], cd: [11, 10, 9, 8, 7], range: 10.5,
      target: 'dir', castTime: 0.25, ind: { t: 'line', w: 1.1 }, bot: { use: 'poke', range: 10 },
      desc: (l, c) => `射出星光，最多命中2个敌人，造成 ${n([80, 125, 170, 215, 260], l)} (+65%法强) 魔法伤害并禁锢1.6秒。`,
      cast: ctx => {
        ctx.w.hooks.sound?.('magic', ctx.ox, ctx.oz)
        skillshot(ctx, {
          range: 10.5, speed: 20, width: 0.55, pierce: 2, vis: { kind: 'star', color: 0xe0c0ff, size: 0.8, trail: true },
          onHit: t => dmg(ctx, t, { m: lv([80, 125, 170, 215, 260], ctx.lvl) + 0.65 * AP(ctx.c), cc: [{ k: 'root', d: 1.6 }] }),
        })
      },
    }),
    S({
      id: 'star.W', name: '陨星坠落', icon: '☄️', maxLv: 5, cost: [60, 60, 60, 60, 60], cd: [8, 7.5, 7, 6.5, 6], range: 9,
      target: 'point', castTime: 0.2, ind: { t: 'circle', r: 2.6 }, bot: { use: 'aoe', range: 9 },
      desc: (l, c) => `召唤陨星砸向目标区域，0.65秒后造成 ${n([70, 115, 160, 205, 250], l)} (+70%法强) 魔法伤害并减速35%。`,
      cast: ctx => {
        aoeCircle(ctx, {
          x: ctx.x, z: ctx.z, r: 2.6, delay: 0.65, color: 0xb36bff, burst: 'explosion',
          onHit: t => dmg(ctx, t, { m: lv([70, 115, 160, 205, 250], ctx.lvl) + 0.7 * AP(ctx.c), cc: [{ k: 'slow', d: 1.5, a: 0.35 }] }),
        })
      },
    }),
    S({
      id: 'star.E', name: '星辉庇护', icon: '💫', maxLv: 5, cost: [50, 50, 50, 50, 50], cd: [12, 11, 10, 9, 8], range: 8,
      target: 'ally', unitTeam: 'ally', champOnly: true, selfCast: true, castTime: 0, ind: { t: 'range' }, bot: { use: 'shield', range: 8 },
      desc: (l, c) => `为友方英雄（或自己）提供 ${n([60, 95, 130, 165, 200], l)} (+45%法强) 护盾，持续2.5秒，并加速20%。`,
      cast: ctx => {
        const t = ctx.target ?? ctx.c
        ctx.w.fx({ kind: 'shieldfx', x: t.x, z: t.z, r: 1.3, color: 0xd9b3ff, dur: 2.5, follow: t })
        buffUnit(ctx, t, { kind: 'shield', dur: 2.5, value: lv([60, 95, 130, 165, 200], ctx.lvl) + 0.45 * AP(ctx.c), key: 'starE' })
        buffUnit(ctx, t, { kind: 'ms', dur: 1.5, value: 0.2, key: 'starEms' })
        ctx.w.hooks.sound?.('shield', t.x, t.z)
      },
    }),
    S({
      id: 'star.R', name: '终焉星光', icon: '🌟', maxLv: 3, cost: [100, 100, 100], cd: [70, 60, 50], range: 26,
      target: 'dir', castTime: 0.25, ind: { t: 'line', w: 2.6 }, bot: { use: 'finisher', range: 22 },
      desc: (l, c) => `蓄力0.9秒后释放一道26码长的星光，对直线上的敌人造成 ${n([300, 425, 550], l)} (+100%法强) 魔法伤害。`,
      cast: ctx => {
        ctx.w.hooks.sound?.('charge', ctx.ox, ctx.oz)
        aoeLine(ctx, {
          len: 26, width: 1.3, delay: 0.9, color: 0xd9a8ff,
          onHit: t => dmg(ctx, t, { m: lv([300, 425, 550], ctx.lvl) + AP(ctx.c) }),
        })
        ctx.w.after(0.9, () => ctx.w.hooks.sound?.('laser', ctx.ox, ctx.oz))
      },
    }),
  ],
}

// -------------------------------------------------------------- 磐石
const rock: ChampDef = {
  id: 'rock', name: '磐石', title: '山岳守卫', role: '坦克', color: 0xa89274, color2: 0x4a3f33, model: 'golem',
  melee: true, windup: 0.3, proj: 0, projVis: { kind: 'rock', color: 0xa89274, size: 0.4 },
  base: { hp: 670, hpRegen: 2.0, mp: 280, mpRegen: 1.5, ad: 62, armor: 40, mr: 32, as: 0.64, range: 1.35, ms: 4.5 },
  growth: { hp: 112, hpRegen: 0.17, mp: 40, mpRegen: 0.1, ad: 3.4, armor: 5, mr: 2.05, as: 0.02 },
  diff: 1, lore: '由古老山脉孕育的岩石巨人，守护峡谷已逾千年。',
  build: ['boots', 'ruby', 'plated_boots', 'sunfire', 'thornmail', 'visage', 'warmog', 'zhonya'],
  skills: [
    S({
      id: 'rock.Q', name: '碎岩投掷', icon: '🪨', maxLv: 5, cost: [60, 60, 60, 60, 60], cd: [8, 8, 8, 8, 8], range: 7.5,
      target: 'unit', unitTeam: 'enemy', castTime: 0.25, ind: { t: 'range' }, bot: { use: 'poke', range: 7.5 },
      desc: (l, c) => `投掷巨石，造成 ${n([70, 115, 160, 205, 250], l)} (+60%法强) 魔法伤害，偷取目标25%移速，持续3秒。`,
      cast: ctx => {
        const t = ctx.target
        if (!t) return
        ctx.w.hooks.sound?.('throw', ctx.ox, ctx.oz)
        homing(ctx, t, {
          speed: 22, vis: { kind: 'rock', color: 0xa89274, size: 0.7 },
          onHit: tt => {
            dmg(ctx, tt, { m: lv([70, 115, 160, 205, 250], ctx.lvl) + 0.6 * AP(ctx.c), cc: [{ k: 'slow', d: 3, a: 0.25 }] })
            buffSelf(ctx, { kind: 'ms', dur: 3, value: 0.25, key: 'rockQ' })
          },
        })
      },
    }),
    S({
      id: 'rock.W', name: '岩石之躯', icon: '🗿', maxLv: 5, cost: [40, 40, 40, 40, 40], cd: [14, 13, 12, 11, 10], range: 0,
      target: 'self', castTime: 0, ind: { t: 'none' }, bot: { use: 'buff' },
      desc: (l, c) => `岩化身体3秒，受到的伤害降低 ${pct(lv([0.25, 0.3, 0.35, 0.4, 0.45], l))}，护甲+20。`,
      cast: ctx => {
        ctx.w.fx({ kind: 'shieldfx', x: ctx.ox, z: ctx.oz, r: 1.6, color: 0xc9a66b, dur: 3, follow: ctx.c })
        buffSelf(ctx, { kind: 'dr', dur: 3, value: lv([0.25, 0.3, 0.35, 0.4, 0.45], ctx.lvl), key: 'rockW' })
        buffSelf(ctx, { kind: 'stat', dur: 3, stats: { armor: 20 }, key: 'rockWarm' })
        ctx.w.hooks.sound?.('shield', ctx.ox, ctx.oz)
      },
    }),
    S({
      id: 'rock.E', name: '震地重击', icon: '💥', maxLv: 5, cost: [50, 50, 50, 50, 50], cd: [8, 7.5, 7, 6.5, 6], range: 3.3,
      target: 'self', castTime: 0.15, ind: { t: 'circle', r: 3.3 }, bot: { use: 'aoe', range: 3.2 },
      desc: (l, c) => `重击地面，对周围敌人造成 ${n([70, 105, 140, 175, 210], l)} (+50%法强 +30%护甲) 魔法伤害并减速40%，持续2秒。`,
      cast: ctx => {
        aoeCircle(ctx, {
          x: ctx.ox, z: ctx.oz, r: 3.3, delay: 0, color: 0xc9a66b, burst: 'nova',
          onHit: t => dmg(ctx, t, { m: lv([70, 105, 140, 175, 210], ctx.lvl) + 0.5 * AP(ctx.c) + 0.3 * ctx.c.stats.armor, cc: [{ k: 'slow', d: 2, a: 0.4 }] }),
        })
      },
    }),
    S({
      id: 'rock.R', name: '山崩地裂', icon: '⛰️', maxLv: 3, cost: [100, 100, 100], cd: [100, 85, 70], range: 9.5,
      target: 'point', castTime: 0, ind: { t: 'circle', r: 3.5 }, bot: { use: 'engage', range: 9 },
      desc: (l, c) => `以不可阻挡之势冲向目标区域，对落点周围敌人造成 ${n([200, 300, 400], l)} (+80%法强) 魔法伤害并击飞1.25秒。`,
      cast: ctx => {
        const [ex, ez] = ctx.w.grid.castWalkable(ctx.ox, ctx.oz, ctx.x, ctx.z)
        ctx.w.hooks.sound?.('dash', ctx.ox, ctx.oz)
        dashTo(ctx, {
          x: ex, z: ez, speed: 30, color: 0xc9a66b, unstoppable: true,
          onEnd: () => aoeCircle(ctx, {
            x: ex, z: ez, r: 3.5, delay: 0, color: 0xd8b070, burst: 'explosion',
            onHit: t => dmg(ctx, t, { m: lv([200, 300, 400], ctx.lvl) + 0.8 * AP(ctx.c), cc: [{ k: 'knockup', d: 1.25 }] }),
          }),
        })
      },
    }),
  ],
}

// -------------------------------------------------------------- 影舞
const shade: ChampDef = {
  id: 'shade', name: '影舞', title: '暗夜刺客', role: '刺客', color: 0x7a5cff, color2: 0x1a1030, model: 'assassin',
  melee: true, windup: 0.25, proj: 0, projVis: { kind: 'blade', color: 0x9a80ff, size: 0.3 },
  base: { hp: 590, hpRegen: 1.5, mp: 300, mpRegen: 1.5, ad: 67, armor: 30, mr: 32, as: 0.68, range: 1.3, ms: 4.75 },
  growth: { hp: 95, hpRegen: 0.14, mp: 40, mpRegen: 0.1, ad: 3.7, armor: 4.5, mr: 2.05, as: 0.03 },
  diff: 3, lore: '在阴影中出没的刺客，目标往往只看见一道紫光。',
  build: ['boots', 'long_sword', 'plated_boots', 'cleaver', 'bloodthirster', 'dawn_blade', 'trinity', 'visage'],
  skills: [
    S({
      id: 'shade.Q', name: '三叉飞刃', icon: '🔪', maxLv: 5, cost: [40, 40, 40, 40, 40], cd: [6, 5.5, 5, 4.5, 4], range: 8.5,
      target: 'dir', castTime: 0.18, ind: { t: 'cone', r: 8.5, a: 0.27 }, bot: { use: 'poke', range: 8 },
      desc: (l, c) => `掷出三把穿透飞刃，每个敌人最多受到一次 ${n([70, 105, 140, 175, 210], l)} (+80%攻击力) 物理伤害。`,
      cast: ctx => {
        ctx.w.hooks.sound?.('throw', ctx.ox, ctx.oz)
        const hitIds = new Set<string>()
        const base = Math.atan2(ctx.dx, ctx.dz)
        for (const off of [-0.26, 0, 0.26]) {
          skillshot(ctx, {
            range: 8.5, speed: 26, width: 0.4, pierce: 99, dx: Math.sin(base + off), dz: Math.cos(base + off), hitIds,
            vis: { kind: 'blade', color: 0xa890ff, size: 0.7, trail: true },
            onHit: t => dmg(ctx, t, { p: lv([70, 105, 140, 175, 210], ctx.lvl) + 0.8 * AD(ctx.c) }),
          })
        }
      },
    }),
    S({
      id: 'shade.W', name: '暗影遁形', icon: '🌑', maxLv: 5, cost: [60, 60, 60, 60, 60], cd: [18, 17, 16, 15, 14], range: 0,
      target: 'self', castTime: 0, ind: { t: 'none' }, bot: { use: 'escape' },
      desc: (l, c) => `遁入阴影 ${lv([2.5, 2.75, 3, 3.25, 3.5], l)} 秒，获得隐身和30%移速。攻击或施放技能会打破隐身。`,
      cast: ctx => {
        const d = lv([2.5, 2.75, 3, 3.25, 3.5], ctx.lvl)
        ctx.w.fx({ kind: 'flash', x: ctx.ox, z: ctx.oz, r: 1.5, color: 0x5a3cff, dur: 0.6 })
        buffSelf(ctx, { kind: 'stealth', dur: d })
        buffSelf(ctx, { kind: 'ms', dur: d, value: 0.3, key: 'shadeW' })
        ctx.w.hooks.sound?.('stealth', ctx.ox, ctx.oz)
      },
    }),
    S({
      id: 'shade.E', name: '影步突袭', icon: '👤', maxLv: 5, cost: [50, 50, 50, 50, 50], cd: [12, 11, 10, 9, 8], range: 6.5,
      target: 'unit', unitTeam: 'any', castTime: 0, ind: { t: 'range' }, bot: { use: 'engage', range: 6.5 },
      desc: (l, c) => `闪现到目标单位身后。若目标为敌人，3秒内下一次普攻额外造成 ${n([40, 65, 90, 115, 140], l)} (+50%攻击力) 物理伤害并减速40%。`,
      cast: ctx => {
        const t = ctx.target
        if (!t) return
        const a = angleTo(ctx.ox, ctx.oz, t.x, t.z)
        const off = t.radius + 1
        blinkTo(ctx, t.x + Math.sin(a) * off, t.z + Math.cos(a) * off, 0x7a5cff)
        if (ctx.c.local) ctx.c.facing = a + Math.PI
        if (ctx.auth && t.team !== ctx.c.team && ctx.ch) {
          ctx.ch.addBuff(ctx.w.now, { kind: 'empower', dur: 3, value: lv([40, 65, 90, 115, 140], ctx.lvl) + 0.5 * AD(ctx.c), key: 'shadeE' }, ctx.c.id)
          ctx.ch.targetId = t.id
          ctx.ch.order = { t: 'attack', id: t.id }
        }
      },
    }),
    S({
      id: 'shade.R', name: '死亡印记', icon: '💀', maxLv: 3, cost: [100, 100, 100], cd: [90, 75, 60], range: 5.5,
      target: 'unit', unitTeam: 'enemy', champOnly: true, castTime: 0, ind: { t: 'range' }, bot: { use: 'finisher', range: 5.5 },
      desc: (l, c) => `瞬移至目标英雄身后并短暂免疫伤害，施加死亡印记。2秒后印记引爆，造成 ${n([150, 250, 350], l)} (+130%攻击力) 物理伤害 + 15%已损失生命值真实伤害。`,
      cast: ctx => {
        const t = ctx.target
        if (!t) return
        const a = angleTo(ctx.ox, ctx.oz, t.x, t.z)
        blinkTo(ctx, t.x + Math.sin(a) * (t.radius + 1), t.z + Math.cos(a) * (t.radius + 1), 0x3a1cff)
        buffSelf(ctx, { kind: 'dr', dur: 0.7, value: 1, key: 'shadeR' })
        ctx.w.fx({ kind: 'mark', x: t.x, z: t.z, r: 1.2, color: 0x8a5cff, dur: 2, follow: t })
        ctx.w.hooks.sound?.('ult', t.x, t.z)
        if (ctx.auth && ctx.ch) { ctx.ch.order = { t: 'attack', id: t.id } }
        if (!ctx.auth) { ctx.w.after(2, () => ctx.w.fx({ kind: 'explosion', x: t.x, z: t.z, r: 2, color: 0x7a3cff, dur: 0.6 })); return }
        ctx.w.after(2, () => {
          ctx.w.fx({ kind: 'explosion', x: t.x, z: t.z, r: 2, color: 0x7a3cff, dur: 0.6 })
          if (!t.dead) dmg(ctx, t, { p: lv([150, 250, 350], ctx.lvl) + 1.3 * AD(ctx.c), ms: 0.15 })
        })
      },
    }),
  ],
}

// -------------------------------------------------------------- 霜语
const frost: ChampDef = {
  id: 'frost', name: '霜语', title: '冰原祈愿者', role: '辅助', color: 0x8fe3ff, color2: 0x2a5a78, model: 'frost',
  melee: false, windup: 0.25, proj: 20, projVis: { kind: 'ice', color: 0xbff0ff, size: 0.35 },
  base: { hp: 555, hpRegen: 1.2, mp: 400, mpRegen: 2.0, ad: 50, armor: 24, mr: 30, as: 0.625, range: 5.9, ms: 4.4 },
  growth: { hp: 90, hpRegen: 0.11, mp: 50, mpRegen: 0.14, ad: 3, armor: 4.2, mr: 1.3, as: 0.02 },
  diff: 1, lore: '来自极北冰原的祭司，她的祈祷能治愈同伴、冻结敌人。',
  build: ['boots', 'amp_tome', 'sorc_boots', 'redemption', 'luden', 'zhonya', 'deathcap', 'visage'],
  skills: [
    S({
      id: 'frost.Q', name: '冰霜新星', icon: '❄️', maxLv: 5, cost: [55, 55, 55, 55, 55], cd: [7, 7, 7, 7, 7], range: 8.5,
      target: 'point', castTime: 0.25, ind: { t: 'circle', r: 2.3 }, bot: { use: 'aoe', range: 8.5 },
      desc: (l, c) => `在目标区域引爆冰霜，造成 ${n([60, 95, 130, 165, 200], l)} (+50%法强) 魔法伤害并减速40%。每命中一名英雄回复 ${n([15, 25, 35, 45, 55], l)} 生命。`,
      cast: ctx => {
        aoeCircle(ctx, {
          x: ctx.x, z: ctx.z, r: 2.3, delay: 0.4, color: 0x8fe3ff, burst: 'nova',
          onHit: t => {
            dmg(ctx, t, { m: lv([60, 95, 130, 165, 200], ctx.lvl) + 0.5 * AP(ctx.c), cc: [{ k: 'slow', d: 1.5, a: 0.4 }] })
            if (t.isChamp) healTarget(ctx, ctx.c, lv([15, 25, 35, 45, 55], ctx.lvl) + 0.1 * AP(ctx.c))
          },
        })
        ctx.w.hooks.sound?.('magic', ctx.ox, ctx.oz)
      },
    }),
    S({
      id: 'frost.W', name: '生命之泉', icon: '💧', maxLv: 5, cost: [70, 70, 70, 70, 70], cd: [6, 5.5, 5, 4.5, 4], range: 7.5,
      target: 'ally', unitTeam: 'ally', champOnly: true, selfCast: true, castTime: 0.15, ind: { t: 'range' }, bot: { use: 'heal', range: 7.5 },
      desc: (l, c) => `治疗友方英雄（或自己） ${n([80, 110, 140, 170, 200], l)} (+55%法强) 生命值。`,
      cast: ctx => {
        const t = ctx.target ?? ctx.c
        healTarget(ctx, t, lv([80, 110, 140, 170, 200], ctx.lvl) + 0.55 * AP(ctx.c))
        ctx.w.hooks.sound?.('heal', t.x, t.z)
      },
    }),
    S({
      id: 'frost.E', name: '寒冰禁锢', icon: '🧊', maxLv: 5, cost: [60, 60, 60, 60, 60], cd: [14, 13, 12, 11, 10], range: 9,
      target: 'dir', castTime: 0.25, ind: { t: 'line', w: 1.0 }, bot: { use: 'poke', range: 9 },
      desc: (l, c) => `射出寒冰，冻结命中的第一个敌人1.2秒，并造成 ${n([60, 95, 130, 165, 200], l)} (+40%法强) 魔法伤害。`,
      cast: ctx => {
        ctx.w.hooks.sound?.('magic', ctx.ox, ctx.oz)
        skillshot(ctx, {
          range: 9, speed: 18, width: 0.5, vis: { kind: 'ice', color: 0xbff0ff, size: 0.9, trail: true },
          onHit: t => dmg(ctx, t, { m: lv([60, 95, 130, 165, 200], ctx.lvl) + 0.4 * AP(ctx.c), cc: [{ k: 'stun', d: 1.2 }] }),
        })
      },
    }),
    S({
      id: 'frost.R', name: '群星祈愿', icon: '🙏', maxLv: 3, cost: [100, 100, 100], cd: [120, 100, 80], range: 0,
      target: 'self', castTime: 0.4, ind: { t: 'none' }, bot: { use: 'heal' },
      desc: (l, c) => `向群星祈愿，为所有友方英雄回复 ${n([150, 250, 350], l)} (+50%法强) 生命值（全图）。`,
      cast: ctx => {
        ctx.w.hooks.sound?.('ult', ctx.ox, ctx.oz)
        for (const a of ctx.w.champs) {
          if (a.team !== ctx.c.team || a.dead) continue
          ctx.w.fx({ kind: 'global', x: a.x, z: a.z, r: 1.4, color: 0xa8f0ff, dur: 1.2, follow: a })
          healTarget(ctx, a, lv([150, 250, 350], ctx.lvl) + 0.5 * AP(ctx.c))
        }
      },
    }),
  ],
}

// -------------------------------------------------------------- 雷枪
const thunder: ChampDef = {
  id: 'thunder', name: '雷枪', title: '雷霆枪骑', role: '战士', color: 0xffd84a, color2: 0x4a3b10, model: 'lancer',
  melee: true, windup: 0.27, proj: 0, projVis: { kind: 'bolt', color: 0xfff08a, size: 0.3 },
  base: { hp: 625, hpRegen: 1.6, mp: 300, mpRegen: 1.4, ad: 64, armor: 34, mr: 32, as: 0.65, range: 1.7, ms: 4.55 },
  growth: { hp: 100, hpRegen: 0.15, mp: 40, mpRegen: 0.1, ad: 3.5, armor: 4.5, mr: 2.05, as: 0.028 },
  diff: 2, lore: '手持雷霆长枪的骑士，每一次突刺都伴随着雷鸣。',
  build: ['boots', 'long_sword', 'plated_boots', 'trinity', 'cleaver', 'bloodthirster', 'sunfire', 'visage'],
  skills: [
    S({
      id: 'thunder.Q', name: '雷枪突刺', icon: '🔱', maxLv: 5, cost: [35, 35, 35, 35, 35], cd: [6, 5.5, 5, 4.5, 4], range: 4.8,
      target: 'dir', castTime: 0.28, ind: { t: 'line', w: 1.5 }, bot: { use: 'poke', range: 4.6 },
      desc: (l, c) => `向前突刺，对直线上的敌人造成 ${n([65, 105, 145, 185, 225], l)} (+110%攻击力) 物理伤害。`,
      cast: ctx => {
        ctx.w.hooks.sound?.('swing', ctx.ox, ctx.oz)
        aoeLine(ctx, {
          len: 4.8, width: 0.75, delay: 0, color: 0xfff08a, kind: 'line',
          onHit: t => dmg(ctx, t, { p: lv([65, 105, 145, 185, 225], ctx.lvl) + 1.1 * AD(ctx.c) }),
        })
      },
    }),
    S({
      id: 'thunder.W', name: '电磁步', icon: '⚡', maxLv: 5, cost: [45, 45, 45, 45, 45], cd: [13, 12, 11, 10, 9], range: 0,
      target: 'self', castTime: 0, ind: { t: 'none' }, bot: { use: 'buff' },
      desc: (l, c) => `获得40%移速，持续2秒。4秒内下一次普攻额外造成 ${n([30, 50, 70, 90, 110], l)} (+40%法强) 魔法伤害并眩晕0.8秒。`,
      cast: ctx => {
        ctx.w.fx({ kind: 'buffglow', x: ctx.ox, z: ctx.oz, r: 1.2, color: 0xffe84a, dur: 2, follow: ctx.c })
        buffSelf(ctx, { kind: 'ms', dur: 2, value: 0.4, key: 'thunderW' })
        buffSelf(ctx, { kind: 'empower', dur: 4, value: lv([30, 50, 70, 90, 110], ctx.lvl) + 0.4 * AP(ctx.c), key: 'thunderWe' })
        ctx.w.hooks.sound?.('zap', ctx.ox, ctx.oz)
      },
    }),
    S({
      id: 'thunder.E', name: '惊雷突进', icon: '🌩️', maxLv: 5, cost: [60, 60, 60, 60, 60], cd: [14, 13, 12, 11, 10], range: 7,
      target: 'point', castTime: 0, ind: { t: 'line', w: 1.3 }, bot: { use: 'engage', range: 7 },
      desc: (l, c) => `冲向目标位置，击飞路径上的敌人0.75秒，并造成 ${n([55, 85, 115, 145, 175], l)} (+70%攻击力) 物理伤害。`,
      cast: ctx => {
        ctx.w.hooks.sound?.('dash', ctx.ox, ctx.oz)
        dashTo(ctx, {
          x: ctx.x, z: ctx.z, speed: 24, width: 1.3, color: 0xfff08a,
          onPass: t => dmg(ctx, t, { p: lv([55, 85, 115, 145, 175], ctx.lvl) + 0.7 * AD(ctx.c), cc: [{ k: 'knockup', d: 0.75 }] }),
        })
      },
    }),
    S({
      id: 'thunder.R', name: '天罚雷霆', icon: '🌋', maxLv: 3, cost: [100, 100, 100], cd: [90, 80, 70], range: 4.5,
      target: 'self', castTime: 0.45, ind: { t: 'circle', r: 4.5 }, bot: { use: 'aoe', range: 4.2 },
      desc: (l, c) => `引导雷霆轰击周围4.5码，造成 ${n([150, 250, 350], l)} (+90%攻击力) 物理伤害并眩晕1.25秒。`,
      cast: ctx => {
        ctx.w.fx({ kind: 'pillar', x: ctx.ox, z: ctx.oz, r: 2.5, color: 0xfff08a, dur: 0.7 })
        ctx.w.hooks.sound?.('thunder', ctx.ox, ctx.oz)
        aoeCircle(ctx, {
          x: ctx.c.local ? ctx.c.x : ctx.ox, z: ctx.c.local ? ctx.c.z : ctx.oz, r: 4.5, delay: 0, color: 0xfff08a, burst: 'explosion',
          onHit: t => dmg(ctx, t, { p: lv([150, 250, 350], ctx.lvl) + 0.9 * AD(ctx.c), cc: [{ k: 'stun', d: 1.25 }] }),
        })
      },
    }),
  ],
}

// -------------------------------------------------------------- 烬火
const fireVis: ProjVis = { kind: 'fire', color: 0xff7a2a, size: 0.8, trail: true }
const ember: ChampDef = {
  id: 'ember', name: '烬火', title: '焚天术士', role: '法师', color: 0xff5a36, color2: 0x5a1a0e, model: 'ember',
  melee: false, windup: 0.25, proj: 20, projVis: { kind: 'fire', color: 0xffa060, size: 0.35 },
  base: { hp: 540, hpRegen: 1.1, mp: 400, mpRegen: 1.7, ad: 52, armor: 22, mr: 30, as: 0.625, range: 6.0, ms: 4.4 },
  growth: { hp: 88, hpRegen: 0.11, mp: 50, mpRegen: 0.12, ad: 3, armor: 4.3, mr: 1.3, as: 0.02 },
  diff: 2, lore: '沉迷于火焰奥秘的术士，所到之处皆成焦土。',
  build: ['boots', 'amp_tome', 'sorc_boots', 'luden', 'deathcap', 'void_staff', 'zhonya', 'visage'],
  skills: [
    S({
      id: 'ember.Q', name: '火球术', icon: '🔥', maxLv: 5, cost: [50, 50, 50, 50, 50], cd: [6, 5.5, 5, 4.5, 4], range: 9.5,
      target: 'dir', castTime: 0.22, ind: { t: 'line', w: 1.0 }, bot: { use: 'poke', range: 9.5 },
      desc: (l, c) => `发射火球，命中后爆炸，对2码内敌人造成 ${n([75, 115, 155, 195, 235], l)} (+70%法强) 魔法伤害并点燃3秒。`,
      cast: ctx => {
        ctx.w.hooks.sound?.('fire', ctx.ox, ctx.oz)
        skillshot(ctx, {
          range: 9.5, speed: 20, width: 0.5, vis: fireVis,
          onHit: (t, p) => {
            for (const u of enemiesInCircle(ctx, p.x, p.z, 2)) {
              dmg(ctx, u, { m: lv([75, 115, 155, 195, 235], ctx.lvl) + 0.7 * AP(ctx.c), cc: [{ k: 'burn', d: 3, a: 20 + 0.1 * AP(ctx.c) }] })
            }
          },
          onEnd: (p, hit) => { if (hit) ctx.w.fx({ kind: 'explosion', x: p.x, z: p.z, r: 2, color: 0xff7a2a, dur: 0.5 }) },
        })
      },
    }),
    S({
      id: 'ember.W', name: '烈焰之地', icon: '🔆', maxLv: 5, cost: [70, 70, 70, 70, 70], cd: [13, 12, 11, 10, 9], range: 8.5,
      target: 'point', castTime: 0.22, ind: { t: 'circle', r: 2.6 }, bot: { use: 'aoe', range: 8.5 },
      desc: (l, c) => `点燃目标区域3秒，每0.5秒对区域内敌人造成 ${n([20, 32, 44, 56, 68], l)} (+12%法强) 魔法伤害并减速20%。`,
      cast: ctx => {
        ctx.w.hooks.sound?.('fire', ctx.x, ctx.z)
        zone(ctx, {
          x: ctx.x, z: ctx.z, r: 2.6, dur: 3, tick: 0.5, color: 0xff5a2a,
          onTick: t => dmg(ctx, t, { m: lv([20, 32, 44, 56, 68], ctx.lvl) + 0.12 * AP(ctx.c), cc: [{ k: 'slow', d: 0.6, a: 0.2 }] }),
        })
      },
    }),
    S({
      id: 'ember.E', name: '灼魂', icon: '👁️', maxLv: 5, cost: [60, 60, 60, 60, 60], cd: [10, 9.5, 9, 8.5, 8], range: 6.5,
      target: 'unit', unitTeam: 'enemy', castTime: 0.2, ind: { t: 'range' }, bot: { use: 'poke', range: 6.5 },
      desc: (l, c) => `对目标造成 ${n([70, 100, 130, 160, 190], l)} (+55%法强) 魔法伤害。若目标处于点燃状态，则眩晕1.2秒。`,
      cast: ctx => {
        const t = ctx.target
        if (!t) return
        ctx.w.hooks.sound?.('fire', ctx.ox, ctx.oz)
        homing(ctx, t, {
          speed: 24, vis: { kind: 'fire', color: 0xffc040, size: 0.7, trail: true },
          onHit: tt => dmg(ctx, tt, {
            m: lv([70, 100, 130, 160, 190], ctx.lvl) + 0.55 * AP(ctx.c),
            cc: tt.has(F.BURN) ? [{ k: 'stun', d: 1.2 }] : undefined,
          }),
        })
      },
    }),
    S({
      id: 'ember.R', name: '陨火天降', icon: '🌠', maxLv: 3, cost: [100, 100, 100], cd: [80, 70, 60], range: 13,
      target: 'point', castTime: 0.3, ind: { t: 'circle', r: 4 }, bot: { use: 'aoe', range: 12 },
      desc: (l, c) => `1秒后在目标区域降下陨火，造成 ${n([250, 375, 500], l)} (+90%法强) 魔法伤害，眩晕1秒并点燃。`,
      cast: ctx => {
        ctx.w.hooks.sound?.('ult', ctx.ox, ctx.oz)
        aoeCircle(ctx, {
          x: ctx.x, z: ctx.z, r: 4, delay: 1.0, color: 0xff5a2a, burst: 'explosion',
          onHit: t => dmg(ctx, t, { m: lv([250, 375, 500], ctx.lvl) + 0.9 * AP(ctx.c), cc: [{ k: 'stun', d: 1 }, { k: 'burn', d: 3, a: 40 + 0.1 * AP(ctx.c) }] }),
        })
      },
    }),
  ],
}

export const CHAMPIONS: ChampDef[] = [blaze, wind, star, rock, shade, frost, thunder, ember]
export const CHAMP_MAP: Record<string, ChampDef> = Object.fromEntries(CHAMPIONS.map(c => [c.id, c]))

export function champSkill(c: ChampDef, i: number) { return c.skills[i] }
export type { CastCtx }
