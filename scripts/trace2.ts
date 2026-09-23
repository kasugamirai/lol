import { World, SlotConfig } from '../src/game/world'
import { CHAMPIONS } from '../src/game/data/champions'
const seed = Number(process.argv[2] ?? 2)
let r = seed * 9301 + 49297
const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280)
const slots: SlotConfig[] = []
for (const team of [0, 1] as const) for (let i = 0; i < 5; i++) {
  const c = CHAMPIONS[Math.floor(rnd() * CHAMPIONS.length)]
  slots.push({ slot: (team ? 'r' : 'b') + i, team, champ: c.id, name: (team ? 'R' : 'B') + i + '-' + c.id, bot: true, spells: ['flash', 'heal'], diff: 1 })
}
const w = new World('rift', slots, null, seed)
w.becomeHost()
const from = Number(process.argv[3] ?? 1500), to = Number(process.argv[4] ?? 1560)
let next = from
while (w.time < to) {
  w.update(0.05, w.time * 1000)
  if (w.time >= next) {
    next += 5
    console.log(`--- t=${w.time.toFixed(0)}`)
    for (const c of w.champs.filter(c => c.team === Number(process.argv[5] ?? 1))) {
      const b: any = c.brain
      const tw = w.towers.filter(t => t.team !== c.team && !t.dead).map(t => [t.id, Math.hypot(t.x - c.x, t.z - c.z)] as const).sort((a, b) => a[1] - b[1])[0]
      console.log(`${c.name.padEnd(12)} ${b.role}/${b.lane} pos ${c.x.toFixed(0)},${c.z.toFixed(0)} hp ${Math.round(c.hp / c.maxHp * 100)}% ${c.dead ? 'DEAD' : ''} order ${JSON.stringify(c.order)} ret ${b.retreating} rec ${c.recallAt >= 0} nearestTower ${tw?.[0]} ${tw?.[1].toFixed(0)}`)
    }
  }
}
