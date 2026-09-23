import type { World } from './world'
import { Champion } from './champion'
import { NetEvent, Team } from './types'
import { MINIONS, MONSTERS, XP_RANGE, killXp, ASSIST_GOLD, TOWER_KILLER_GOLD, TOWER_TEAM_GOLD, INHIB_TEAM_GOLD, FIRST_BLOOD_GOLD } from './data/units'
import { dist } from '../util/math'

type DeathEv = Extract<NetEvent, { e: 'death' }>

const multi = new Map<string, { n: number; t: number }>()
const MULTI = ['', '', '双杀！', '三杀！', '四杀！', '五杀！']

export function handleDeathRewards(w: World, ev: DeathEv) {
  const victim = w.unit(ev.id)
  if (victim && !victim.local && !victim.dead) {
    victim.dead = true
    victim.deadAt = w.now
    victim.hp = 0
  }
  const killer = w.unit(ev.k)
  const mine = (t: Team) => t === w.myTeam
  if (ev.uk === 'champ') {
    if (killer && killer.isChamp && killer.team !== ev.tm) w.teamKills[killer.team as 0 | 1]++
    if (ev.fb) w.firstBlood = true
    if (victim) w.hooks.killFeed?.(killer, victim, ev.as)
    let text = ''
    let color = '#ffffff'
    if (killer && killer.isChamp) {
      const m = multi.get(killer.id)
      const n = m && w.now - m.t < 10 ? m.n + 1 : 1
      multi.set(killer.id, { n, t: w.now })
      if (ev.fb) text = '第一滴血！'
      if (n >= 2) text = MULTI[Math.min(5, n)]
    }
    if (!text) {
      if (victim === w.me) text = '你已被击杀'
      else if (killer === w.me) text = '你击杀了一名敌人！'
      else if (!w.spectator) text = mine(ev.tm) ? '我方英雄阵亡' : '敌方英雄被击杀'
    }
    color = w.spectator ? '#ffffff' : mine(ev.tm) ? '#ff6a6a' : '#6ab4ff'
    const sub = killer ? `${killer.name || '单位'} → ${victim?.name ?? ''}` : `${victim?.name ?? ''} 被处决`
    if (text) w.hooks.announce?.(text, sub, color)
    // ace
    const enemyTeam = ev.tm
    if (killer && killer.team !== enemyTeam && w.champs.filter(c => c.team === enemyTeam).every(c => c.dead)) {
      w.after(1.2, () => w.hooks.announce?.('团灭！', undefined, mine(enemyTeam) ? '#ff6a6a' : '#6ab4ff'))
    }
    w.hooks.sound?.(killer === w.me ? 'kill' : 'death2')
  } else if (ev.uk === 'tower') {
    w.towersKilled[(1 - ev.tm) as 0 | 1]++
    w.hooks.announce?.(w.spectator ? '防御塔被摧毁' : mine(ev.tm) ? '我方防御塔已被摧毁' : '敌方防御塔已被摧毁', undefined, mine(ev.tm) ? '#ff6a6a' : '#6ab4ff')
    w.fx({ kind: 'explosion', x: ev.x, z: ev.z, r: 4, color: 0xffaa55, dur: 1.2 })
    w.hooks.sound?.('towerdown', ev.x, ev.z)
  } else if (ev.uk === 'inhib') {
    w.hooks.announce?.(mine(ev.tm) ? '我方水晶枢纽已被摧毁' : '敌方水晶枢纽已被摧毁', undefined, mine(ev.tm) ? '#ff6a6a' : '#6ab4ff')
    w.fx({ kind: 'explosion', x: ev.x, z: ev.z, r: 4, color: 0xaa66ff, dur: 1.2 })
    w.hooks.sound?.('towerdown', ev.x, ev.z)
  } else if (ev.uk === 'monster' && (ev.ut === 'dragon' || ev.ut === 'baron')) {
    const kt = killer ? killer.team : -1
    if (kt === 0 || kt === 1) {
      if (ev.ut === 'dragon') w.dragons[kt]++
      else w.barons[kt]++
    }
    const name = ev.ut === 'dragon' ? '远古巨龙' : '纳什男爵'
    w.hooks.announce?.(kt === w.myTeam ? `我方击杀了${name}` : `敌方击杀了${name}`, ev.ut === 'dragon' ? '全队获得巨龙之力：伤害提升5%' : '全队获得男爵之手：+30攻击力 +50法强，回城加速', kt === w.myTeam ? '#6ab4ff' : '#ff6a6a')
  }
  if (ev.uk !== 'champ' && ev.uk !== 'minion') w.fx({ kind: 'death', x: ev.x, z: ev.z, r: 1.5, color: 0xffffff, dur: 1 })

  for (const c of w.champs) if (c.local) reward(w, c, ev, killer ? killer.team : -1)
}

function reward(w: World, c: Champion, ev: DeathEv, killerTeam: number) {
  const enemy = ev.tm !== c.team
  if (ev.k === c.id) {
    switch (ev.uk) {
      case 'champ':
        c.kills++
        c.streak++
        c.deathStreak = 0
        c.addGold((ev.b ?? 300) + (ev.fb ? FIRST_BLOOD_GOLD : 0))
        break
      case 'minion':
        c.cs++
        c.addGold(MINIONS[ev.ut as keyof typeof MINIONS]?.gold ?? 20)
        break
      case 'monster': {
        c.cs++
        const md = MONSTERS[ev.ut as keyof typeof MONSTERS]
        c.addGold(md?.gold ?? 50)
        if (ev.ut === 'sentinel') c.addBuff(w.now, { kind: 'blue', dur: 90 })
        if (ev.ut === 'brambleback') c.addBuff(w.now, { kind: 'red', dur: 90 })
        break
      }
      case 'tower':
        c.addGold(TOWER_KILLER_GOLD)
        break
      case 'ward':
        c.addGold(30)
        break
    }
  }
  if (ev.uk === 'champ' && ev.as.includes(c.id)) {
    c.assists++
    c.addGold(Math.round(ASSIST_GOLD / Math.max(1, ev.as.length)))
  }
  if (enemy && ev.uk === 'tower') c.addGold(TOWER_TEAM_GOLD, ev.k !== c.id)
  if (enemy && ev.uk === 'inhib') c.addGold(INHIB_TEAM_GOLD)
  if (ev.uk === 'monster' && (ev.ut === 'dragon' || ev.ut === 'baron') && killerTeam === c.team) {
    if (ev.ut === 'dragon') { c.addBuff(w.now, { kind: 'dragon', dur: 99999, value: 1 }); c.addGold(50, false) }
    else { if (!c.dead) c.addBuff(w.now, { kind: 'baron', dur: 150 }); c.addGold(300) }
  }
  // experience
  if (c.dead) return
  const d = dist(c.x, c.z, ev.x, ev.z)
  if (d > XP_RANGE) return
  let xp = 0
  if (ev.uk === 'champ' && enemy) xp = killXp(ev.lv ?? 1)
  else if (ev.uk === 'minion' && enemy) xp = MINIONS[ev.ut as keyof typeof MINIONS]?.xp ?? 0
  else if (ev.uk === 'monster' && killerTeam === c.team) xp = MONSTERS[ev.ut as keyof typeof MONSTERS]?.xp ?? 0
  if (xp <= 0) return
  const n = w.champs.filter(o => o.team === c.team && !o.dead && dist(o.x, o.z, ev.x, ev.z) <= XP_RANGE).length
  c.addXp(n > 1 ? (xp * 1.3) / n : xp)
}
