import { World, SlotConfig } from '../src/game/world'
import { CHAMPIONS } from '../src/game/data/champions'

const mapId = (process.argv[2] ?? 'rift') as 'rift' | 'aram'
const minutes = Number(process.argv[3] ?? 25)
const size = Number(process.argv[4] ?? 5)
const seed = Number(process.argv[5] ?? 1)
let r = seed * 9301 + 49297
const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280)
const slots: SlotConfig[] = []
for (const team of [0, 1] as const) for (let i = 0; i < size; i++) {
  const c = CHAMPIONS[Math.floor(rnd() * CHAMPIONS.length)]
  slots.push({ slot: (team ? 'r' : 'b') + i, team, champ: c.id, name: (team ? 'R' : 'B') + i + '-' + c.id, bot: true, spells: ['flash', 'heal'], diff: 1 })
}
const w = new World(mapId, slots, null, seed)
w.becomeHost()
const log: string[] = []
w.hooks = {
  announce: (t, sub) => log.push(`[${w.time.toFixed(0)}s] ${t} ${sub ?? ''}`),
  gameOver: win => log.push(`GAME OVER winner=${win} at ${w.time.toFixed(0)}s`),
}
const dt = 0.05
let errors = 0
const t0 = performance.now()
let steps = 0
while (w.time < minutes * 60 && w.winner === -1) {
  try { w.update(dt, w.time * 1000) } catch (e) { errors++; if (errors < 5) console.error('ERR at', w.time.toFixed(1), e) }
  steps++
  if (steps % Math.round(60 / dt) === 0) {
    const minions = [...w.units.values()].filter(u => u.kind === 'minion' && !u.dead).length
    const mons = [...w.units.values()].filter(u => u.kind === 'monster' && !u.dead).length
    console.log(`t=${(w.time / 60).toFixed(0)}m kills ${w.teamKills.join(':')} towers ${w.towersKilled.join(':')} minions ${minions} monsters ${mons} lv ${w.champs.map(c => c.level).join(',')}`)
  }
}
// drain end timers
for (let i = 0; i < 60; i++) w.update(dt, w.time * 1000)
const ms = performance.now() - t0
console.log(`\nsimulated ${(w.time / 60).toFixed(1)} min in ${(ms / 1000).toFixed(1)}s (${(ms / steps).toFixed(2)} ms/step), errors=${errors}, winner=${w.winner}`)
for (const c of w.champs) console.log(`${c.name.padEnd(14)} lv${String(c.level).padStart(2)} ${c.kills}/${c.deaths}/${c.assists} cs ${String(c.cs).padStart(3)} gold ${Math.floor(c.goldTotal)} items ${c.items.filter(Boolean).join(',')}`)
console.log(log.slice(0, 60).join('\n'))
