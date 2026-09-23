import { registerSkill } from '../skillreg'
import { SkillDef, blinkTo, clampToRange, healTarget, buffSelf, buffUnit, dmg, alliesInCircle } from '../skills'
import { Champion } from '../champion'

export interface SpellDef {
  id: string
  name: string
  icon: string
  cd: number
  desc: string
  skill: SkillDef
}

function spell(id: string, name: string, icon: string, cd: number, desc: string, s: Omit<SkillDef, 'id' | 'name' | 'icon' | 'maxLv' | 'cost' | 'cd' | 'desc'>): SpellDef {
  const skill = registerSkill({ id: 'spell.' + id, name, icon, maxLv: 1, cost: [0], cd: [cd], desc: () => desc, ...s })
  return { id, name, icon, cd, desc, skill }
}

export const SPELLS: SpellDef[] = [
  spell('flash', '闪现', '✴️', 180, '向指针方向瞬移至多4.5码。', {
    range: 4.5, target: 'point', noClamp: true, castTime: 0, ind: { t: 'range' }, bot: { use: 'escape', range: 4.5 },
    cast: ctx => {
      const [x, z] = clampToRange(ctx.ox, ctx.oz, ctx.x, ctx.z, 4.5)
      blinkTo(ctx, x, z)
    },
  }),
  spell('heal', '治疗术', '💖', 150, '为自己和附近生命值最低的友方英雄回复 90+15×等级 生命值，并加速30%持续1秒。', {
    range: 8, target: 'self', castTime: 0, ind: { t: 'range' }, bot: { use: 'heal' },
    cast: ctx => {
      const amt = 90 + 15 * ctx.lvl
      healTarget(ctx, ctx.c, amt)
      buffSelf(ctx, { kind: 'ms', dur: 1, value: 0.3, key: 'healms' })
      const allies = alliesInCircle(ctx, ctx.ox, ctx.oz, 8).filter(a => a !== ctx.c)
      allies.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)
      if (allies[0]) healTarget(ctx, allies[0], amt)
      ctx.w.hooks.sound?.('heal', ctx.ox, ctx.oz)
    },
  }),
  spell('ignite', '引燃', '🔥', 120, '点燃6码内的敌方英雄，5秒内造成 70+20×等级 真实伤害，并使其受到的治疗效果降低40%。', {
    range: 6, target: 'unit', unitTeam: 'enemy', champOnly: true, castTime: 0, ind: { t: 'range' }, bot: { use: 'finisher', range: 6 },
    cast: ctx => {
      const t = ctx.target
      if (!t) return
      ctx.w.fx({ kind: 'mark', x: t.x, z: t.z, r: 1, color: 0xff6a2a, dur: 5, follow: t })
      dmg(ctx, t, { cc: [{ k: 'burn', d: 5, a: 70 + 20 * ctx.lvl }] })
      buffUnit(ctx, t, { kind: 'grievous', dur: 5 })
      ctx.w.hooks.sound?.('fire', t.x, t.z)
    },
  }),
  spell('ghost', '疾跑', '👻', 150, '获得35%移动速度，持续8秒。', {
    range: 0, target: 'self', castTime: 0, ind: { t: 'none' }, bot: { use: 'escape' },
    cast: ctx => {
      ctx.w.fx({ kind: 'buffglow', x: ctx.ox, z: ctx.oz, r: 1.2, color: 0xb0f0ff, dur: 8, follow: ctx.c })
      buffSelf(ctx, { kind: 'ms', dur: 8, value: 0.35, key: 'ghost' })
    },
  }),
  spell('smite', '惩戒', '⚡', 60, '对5码内的野怪或小兵造成 390+20×等级 真实伤害。', {
    range: 5, target: 'unit', unitTeam: 'enemy', castTime: 0, ind: { t: 'range' }, bot: { use: 'none' },
    cast: ctx => {
      const t = ctx.target
      if (!t) return
      ctx.w.fx({ kind: 'pillar', x: t.x, z: t.z, r: 1.2, color: 0xfff2a0, dur: 0.5, follow: t })
      if (t.kind === 'monster' || t.kind === 'minion') dmg(ctx, t, { t: 390 + 20 * ctx.lvl })
      ctx.w.hooks.sound?.('zap', t.x, t.z)
    },
  }),
  spell('barrier', '屏障', '🔰', 150, '获得 105+20×等级 点护盾，持续2.5秒。', {
    range: 0, target: 'self', castTime: 0, ind: { t: 'none' }, bot: { use: 'buff' },
    cast: ctx => {
      ctx.w.fx({ kind: 'shieldfx', x: ctx.ox, z: ctx.oz, r: 1.4, color: 0xfff0a0, dur: 2.5, follow: ctx.c })
      buffSelf(ctx, { kind: 'shield', dur: 2.5, value: 105 + 20 * ctx.lvl, key: 'barrier' })
      ctx.w.hooks.sound?.('shield', ctx.ox, ctx.oz)
    },
  }),
  spell('cleanse', '净化', '🌀', 150, '移除身上所有控制效果和减速。', {
    range: 0, target: 'self', castTime: 0, ind: { t: 'none' }, bot: { use: 'none' },
    cast: ctx => {
      ctx.w.fx({ kind: 'flash', x: ctx.ox, z: ctx.oz, r: 1.4, color: 0xffffff, dur: 0.5 })
      if (ctx.c.local) ctx.c.buffs = ctx.c.buffs.filter(b => !['stun', 'root', 'slow', 'silence', 'knockup', 'burn', 'grievous'].includes(b.kind))
    },
  }),
]
export const SPELL_MAP: Record<string, SpellDef> = Object.fromEntries(SPELLS.map(s => [s.id, s]))

// ------------------------------------------------------------- item actives & trinket
export const ITEM_ACTIVES: Record<string, SkillDef> = {
  potion: registerSkill({
    id: 'item.potion', name: '生命药水', icon: '🧪', maxLv: 1, cost: [0], cd: [1], range: 0, target: 'self', castTime: 0,
    ind: { t: 'none' }, bot: { use: 'heal' }, desc: () => '12秒内回复150生命值',
    cast: ctx => {
      buffSelf(ctx, { kind: 'regen', dur: 12, value: 150 / 12, key: 'potion' })
      ctx.w.fx({ kind: 'heal', x: ctx.ox, z: ctx.oz, r: 1, color: 0xff6a8a, dur: 0.8, follow: ctx.c })
    },
  }),
  zhonya: registerSkill({
    id: 'item.zhonya', name: '凝滞', icon: '⏳', maxLv: 1, cost: [0], cd: [120], range: 0, target: 'self', castTime: 0,
    ind: { t: 'none' }, bot: { use: 'escape' }, desc: () => '进入2.5秒凝滞状态',
    cast: ctx => {
      ctx.w.fx({ kind: 'shieldfx', x: ctx.ox, z: ctx.oz, r: 1.3, color: 0xffd700, dur: 2.5, follow: ctx.c, data: { gold: true } })
      if (ctx.c.local) {
        ctx.c.addBuff(ctx.w.now, { kind: 'stasis', dur: 2.5 }, ctx.c.id)
        if (ctx.c instanceof Champion) ctx.c.interrupt()
      }
      ctx.w.hooks.sound?.('shield', ctx.ox, ctx.oz)
    },
  }),
  redemption: registerSkill({
    id: 'item.redemption', name: '救赎之光', icon: '✨', maxLv: 1, cost: [0], cd: [90], range: 6, target: 'self', castTime: 0,
    ind: { t: 'circle', r: 6 }, bot: { use: 'heal' }, desc: () => '治疗自身及6码内友军',
    cast: ctx => {
      ctx.w.fx({ kind: 'nova', x: ctx.ox, z: ctx.oz, r: 6, color: 0xfff6b0, dur: 0.8 })
      for (const a of alliesInCircle(ctx, ctx.ox, ctx.oz, 6)) healTarget(ctx, a, 180 + 12 * ctx.lvl)
      ctx.w.hooks.sound?.('heal', ctx.ox, ctx.oz)
    },
  }),
}

export const WARD_SKILL = registerSkill({
  id: 'trinket.ward', name: '侦查守卫', icon: '👁️', maxLv: 1, cost: [0], cd: [4], range: 6, target: 'point', castTime: 0,
  ind: { t: 'range' }, bot: { use: 'none' }, desc: () => '放置一个持续90秒的守卫，提供视野。最多储存2次，每60秒充能1次。',
  cast: ctx => {
    if (!ctx.auth) return
    const [x, z] = clampToRange(ctx.ox, ctx.oz, ctx.x, ctx.z, 6)
    const p = ctx.w.grid.isWalkable(x, z) ? [x, z] : ctx.w.grid.nearestWalkable(x, z, 3)
    if (!p) return
    const ev = { e: 'ward' as const, tm: ctx.c.team, x: +p[0].toFixed(1), z: +p[1].toFixed(1), src: ctx.c.id }
    ctx.w.emit(ev)
    ctx.w.handleEvent(ev, false)
    ctx.w.hooks.sound?.('ward', p[0], p[1])
  },
})
