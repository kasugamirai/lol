import type { World } from './world'
import { F } from './types'
import { Unit } from './unit'

/**
 * Per-team visibility grid (1 cell = 1 unit). Walls block sight; brush cells are only visible
 * to sources standing in the same brush. Stealthed units are visible only very close to enemies.
 */
export class Vision {
  readonly S: number
  vis: [Uint8Array, Uint8Array]
  private acc = 0
  version = 0

  constructor(private w: World) {
    this.S = w.map.size
    const N = this.S * this.S
    this.vis = [new Uint8Array(N), new Uint8Array(N)]
  }

  update(dt: number) {
    this.acc -= dt
    if (this.acc > 0) return
    this.acc = 0.12
    const w = this.w
    const teams: (0 | 1)[] = w.isHost || w.spectator ? [0, 1] : [w.myTeam as 0 | 1]
    for (const t of teams) this.compute(t)
    this.version++
    // unit visibility
    for (const u of w.units.values()) {
      for (const t of [0, 1] as const) {
        if (!teams.includes(t)) { u.vis[t] = true; continue }
        u.vis[t] = u.team === t || this.unitVisible(t, u)
      }
    }
  }

  private unitVisible(team: 0 | 1, u: Unit) {
    if (u.isStructure) return true
    if (u.dead && u.kind !== 'champ') return this.cellVisible(team, u.x, u.z)
    if (u.has(F.STEALTH)) {
      for (const c of this.w.champs) {
        if (c.team === team && !c.dead && Math.hypot(c.x - u.x, c.z - u.z) < 2.6) return true
      }
      return false
    }
    return this.cellVisible(team, u.x, u.z)
  }

  cellVisible(team: 0 | 1, x: number, z: number) {
    const i = Math.floor(x), j = Math.floor(z)
    if (i < 0 || j < 0 || i >= this.S || j >= this.S) return false
    return this.vis[team][j * this.S + i] > 0
  }

  private compute(team: 0 | 1) {
    const w = this.w
    const S = this.S
    const g = w.grid
    const v = this.vis[team]
    v.fill(0)
    for (const u of w.units.values()) {
      if (u.team !== team || u.dead) continue
      const r = w.sightOf(u)
      if (r <= 0) continue
      const los = u.kind === 'champ' || u.kind === 'ward'
      this.reveal(v, u.x, u.z, r, los, g.brushAt(u.x, u.z))
    }
    // fountain & base platform
    const f = w.map.fountains[team]
    this.reveal(v, f.x, f.z, 12, false, 0)
    void S
  }

  private reveal(v: Uint8Array, x: number, z: number, r: number, los: boolean, brush: number) {
    const g = this.w.grid
    const S = this.S
    const i0 = Math.max(0, Math.floor(x - r)), i1 = Math.min(S - 1, Math.floor(x + r))
    const j0 = Math.max(0, Math.floor(z - r)), j1 = Math.min(S - 1, Math.floor(z + r))
    const r2 = r * r
    const walk = g.walk, br = g.brush
    for (let j = j0; j <= j1; j++) {
      const cz = j + 0.5
      for (let i = i0; i <= i1; i++) {
        const k = j * S + i
        if (v[k]) continue
        const cx = i + 0.5
        const dx = cx - x, dz = cz - z
        if (dx * dx + dz * dz > r2) continue
        const b = br[k]
        if (b && b !== brush) continue
        if (los && !this.ray(x, z, cx, cz)) continue
        if (!walk[k] && !los) {
          // non-LOS sources still shouldn't light up walls deep inside
          if (g.wallDist[k] > 2) continue
        }
        v[k] = 1
      }
    }
    void walk
  }

  /** true if the segment from (x0,z0) to cell center hits no wall before the target cell */
  private ray(x0: number, z0: number, x1: number, z1: number) {
    const g = this.w.grid
    const S = this.S
    let i = Math.floor(x0), j = Math.floor(z0)
    const ie = Math.floor(x1), je = Math.floor(z1)
    const dx = x1 - x0, dz = z1 - z0
    const si = dx > 0 ? 1 : -1, sj = dz > 0 ? 1 : -1
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity
    const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity
    let tmx = dx !== 0 ? (dx > 0 ? i + 1 - x0 : x0 - i) * tdx : Infinity
    let tmz = dz !== 0 ? (dz > 0 ? j + 1 - z0 : z0 - j) * tdz : Infinity
    let n = Math.abs(ie - i) + Math.abs(je - j) + 1
    while (n-- > 0) {
      if (i === ie && j === je) return true
      if (i < 0 || j < 0 || i >= S || j >= S) return false
      if (!g.walk[j * S + i]) return false
      if (tmx < tmz) { tmx += tdx; i += si } else { tmz += tdz; j += sj }
    }
    return true
  }
}
