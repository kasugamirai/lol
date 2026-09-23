import { World, SlotConfig } from '../src/game/world'
const picks = ['shade', 'star', 'ember', 'thunder', 'wind', 'ember', 'frost', 'thunder', 'shade', 'thunder']
const slots: SlotConfig[] = []
for (const team of [0, 1] as const) for (let i = 0; i < 5; i++) {
  const c = picks[team * 5 + i]
  slots.push({ slot: (team ? 'r' : 'b') + i, team, champ: c, name: (team ? 'R' : 'B') + i + '-' + c, bot: true, spells: ['flash', 'heal'], diff: 1 })
}
const w = new World('rift', slots, null, 1)
w.becomeHost()
const who = process.argv[2] ?? 'b0'
const c = w.champs.find(x => x.slot === who)!
let next = 0
while (w.time < Number(process.argv[3] ?? 300)) {
  w.update(0.05, w.time * 1000)
  if (w.time >= next) {
    next += 6
    const b: any = c.brain
    console.log(`${w.time.toFixed(0).padStart(4)} pos ${c.x.toFixed(0)},${c.z.toFixed(0)} hp ${Math.round(c.hp / c.maxHp * 100)}% mp ${Math.round(c.mp / Math.max(1, c.maxMp) * 100)}% g ${Math.round(c.gold)} lv ${c.level} order ${JSON.stringify(c.order)} rec ${c.recallAt >= 0 ? (w.now - c.recallAt).toFixed(1) : '-'} ret ${b.retreating} dead ${c.dead} cs ${c.cs} path ${c.path?.length ?? '-'}:${c.pathIdx}`)
  }
}
