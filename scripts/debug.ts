import { World, SlotConfig } from '../src/game/world'
import { CHAMPIONS } from '../src/game/data/champions'
import { Minion } from '../src/game/npc'

const slots: SlotConfig[] = []
const picks = ['shade', 'star', 'ember', 'thunder', 'wind', 'ember', 'frost', 'thunder', 'shade', 'thunder']
for (const team of [0, 1] as const) for (let i = 0; i < 5; i++) {
  const c = picks[team * 5 + i]
  slots.push({ slot: (team ? 'r' : 'b') + i, team, champ: c, name: (team ? 'R' : 'B') + i + '-' + c, bot: true, spells: ['flash', 'heal'], diff: 1 })
}
const w = new World('rift', slots, null, 1)
w.becomeHost()
const until = Number(process.argv[2] ?? 120)
while (w.time < until) w.update(0.05, w.time * 1000)
console.log('t=', w.time.toFixed(0))
for (const c of w.champs) {
  console.log(c.name.padEnd(12), (c.brain as any)?.role, 'pos', c.x.toFixed(0), c.z.toFixed(0), 'hp', Math.round(c.hp) + '/' + Math.round(c.maxHp), 'mp', Math.round(c.mp) + '/' + Math.round(c.maxMp), 'order', JSON.stringify(c.order), 'recall', c.recallAt >= 0, 'dead', c.dead, 'retreat', (c.brain as any)?.retreating)
}
const ms = [...w.units.values()].filter(u => u instanceof Minion && !u.dead) as Minion[]
const byLane: Record<string, number[]> = {}
for (const m of ms) { const k = m.lane + m.team; (byLane[k] ??= []).push(Math.round(m.x), Math.round(m.z)) }
for (const [k, v] of Object.entries(byLane)) console.log(k, v.length / 2, 'sample', v.slice(0, 12).join(','))
const stuck = ms.filter(m => !m.moving).length
console.log('minions', ms.length, 'not moving', stuck)
