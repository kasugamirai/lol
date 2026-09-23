import { World, SlotConfig } from '../src/game/world'
import { dealDamage } from '../src/game/combat'
import { Minion } from '../src/game/npc'
import { closestS, polylineLength } from '../src/util/math'
const slots: SlotConfig[] = []
for (const team of [0, 1] as const) for (let i = 0; i < 5; i++) slots.push({ slot: (team ? 'r' : 'b') + i, team, champ: 'wind', name: 'x' + team + i, bot: true, spells: ['flash', 'heal'], diff: 1 })
const w = new World('rift', slots, null, 1)
w.becomeHost()
const t = w.towers.find(t => t.id === 'tr-mid-1')!
const c = w.champs[0]
console.log('tower hp', t.hp, 'protected', w.isProtected(t))
dealDamage(w, c, t, { p: 100, aa: true })
console.log('after hit', t.hp)
// lane front over time
const fronts = () => {
  const out: string[] = []
  for (const lane of ['top', 'mid', 'bot'] as const) {
    const pts = w.map.lanes[lane]!, L = polylineLength(pts)
    let b = -1, r = 999
    for (const u of w.units.values()) if (u instanceof Minion && !u.dead && u.lane === lane) {
      const s = closestS(pts, u.x, u.z)
      if (u.team === 0) b = Math.max(b, s); else r = Math.min(r, s)
    }
    out.push(`${lane}: blue ${(b / L * 100).toFixed(0)}% red ${(r / L * 100).toFixed(0)}%`)
  }
  return out.join(' | ')
}
while (w.time < 900) {
  w.update(0.05, w.time * 1000)
  if (Math.round(w.time * 20) % (20 * 60) === 0) console.log(`t=${(w.time / 60).toFixed(0)} ${fronts()} towers hp ${w.towers.filter(x => x.hp < x.maxHp).map(x => x.id + ':' + Math.round(x.hp)).join(',')}`)
}
