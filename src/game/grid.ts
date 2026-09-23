import { MapDef, Shape } from './mapdef'
import { clamp, fbm, segDist2 } from '../util/math'

/**
 * Rasterised map: 1 cell = 1 world unit. Cell (i,j) covers [i,i+1)x[j,j+1).
 */
export class Grid {
  readonly S: number
  readonly walk: Uint8Array
  readonly block: Uint8Array // dynamic blockers (structures)
  readonly brush: Uint8Array // brush id (0 = none)
  readonly river: Uint8Array
  readonly lane: Uint8Array
  readonly plaza: Uint8Array // team+1
  readonly wallDist: Float32Array // distance from wall cell to nearest walkable (0 on walkable)
  readonly heights: Float32Array // (S+1)^2 vertex heights
  // A* scratch
  private g: Float32Array
  private came: Int32Array
  private stamp: Uint32Array
  private closed: Uint32Array
  private gen = 1

  constructor(public map: MapDef) {
    const S = (this.S = map.size)
    const N = S * S
    this.walk = new Uint8Array(N)
    this.block = new Uint8Array(N)
    this.brush = new Uint8Array(N)
    this.river = new Uint8Array(N)
    this.lane = new Uint8Array(N)
    this.plaza = new Uint8Array(N)
    this.wallDist = new Float32Array(N)
    this.heights = new Float32Array((S + 1) * (S + 1))
    this.g = new Float32Array(N)
    this.came = new Int32Array(N)
    this.stamp = new Uint32Array(N)
    this.closed = new Uint32Array(N)

    for (const s of map.walk) this.raster(s, i => (this.walk[i] = 1))
    for (const s of map.river) this.raster(s, i => { this.walk[i] = 1; this.river[i] = 1 })
    map.brush.forEach((s, k) => this.raster(s, i => { this.walk[i] = 1; this.brush[i] = k + 1 }))
    for (const k of map.laneIds) this.raster({ t: 'capsule', pts: map.lanes[k]!, hw: map.laneHW - 1.5 }, i => (this.lane[i] = 1))
    for (const p of map.plaza) this.raster(p.shape, i => (this.plaza[i] = p.team + 1))
    // hard border
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      if (i < 3 || j < 3 || i >= S - 3 || j >= S - 3) this.walk[j * S + i] = 0
    }
    this.computeWallDist()
    this.computeHeights()
  }

  private raster(s: Shape, f: (idx: number) => void) {
    const S = this.S
    if (s.t === 'circle') {
      const r2 = s.r * s.r
      const i0 = Math.max(0, Math.floor(s.x - s.r)), i1 = Math.min(S - 1, Math.ceil(s.x + s.r))
      const j0 = Math.max(0, Math.floor(s.z - s.r)), j1 = Math.min(S - 1, Math.ceil(s.z + s.r))
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const dx = i + 0.5 - s.x, dz = j + 0.5 - s.z
        if (dx * dx + dz * dz <= r2) f(j * S + i)
      }
    } else {
      const hw2 = s.hw * s.hw
      for (let k = 1; k < s.pts.length; k++) {
        const [ax, az] = s.pts[k - 1], [bx, bz] = s.pts[k]
        const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - s.hw)), i1 = Math.min(S - 1, Math.ceil(Math.max(ax, bx) + s.hw))
        const j0 = Math.max(0, Math.floor(Math.min(az, bz) - s.hw)), j1 = Math.min(S - 1, Math.ceil(Math.max(az, bz) + s.hw))
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          if (segDist2(i + 0.5, j + 0.5, ax, az, bx, bz) <= hw2) f(j * S + i)
        }
      }
    }
  }

  private computeWallDist() {
    const S = this.S, d = this.wallDist
    const INF = 1e9
    for (let i = 0; i < S * S; i++) d[i] = this.walk[i] ? 0 : INF
    const a = 1, b = Math.SQRT2
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const k = j * S + i
      let v = d[k]
      if (i > 0) v = Math.min(v, d[k - 1] + a)
      if (j > 0) v = Math.min(v, d[k - S] + a)
      if (i > 0 && j > 0) v = Math.min(v, d[k - S - 1] + b)
      if (i < S - 1 && j > 0) v = Math.min(v, d[k - S + 1] + b)
      d[k] = v
    }
    for (let j = S - 1; j >= 0; j--) for (let i = S - 1; i >= 0; i--) {
      const k = j * S + i
      let v = d[k]
      if (i < S - 1) v = Math.min(v, d[k + 1] + a)
      if (j < S - 1) v = Math.min(v, d[k + S] + a)
      if (i < S - 1 && j < S - 1) v = Math.min(v, d[k + S + 1] + b)
      if (i > 0 && j < S - 1) v = Math.min(v, d[k + S - 1] + b)
      d[k] = v
    }
  }

  private computeHeights() {
    const S = this.S, V = S + 1
    const cellH = (i: number, j: number) => {
      i = clamp(i, 0, S - 1); j = clamp(j, 0, S - 1)
      const k = j * S + i
      if (this.walk[k]) return this.river[k] ? -0.42 : 0
      const dd = this.wallDist[k]
      const n = fbm(i * 0.11, j * 0.11, 3)
      return Math.min(1, Math.pow(dd / 2.4, 0.75)) * (2.4 + n * 1.8)
    }
    for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) {
      const h = (cellH(i - 1, j - 1) + cellH(i, j - 1) + cellH(i - 1, j) + cellH(i, j)) / 4
      this.heights[j * V + i] = h
    }
  }

  inBounds(i: number, j: number) { return i >= 0 && j >= 0 && i < this.S && j < this.S }
  idx(x: number, z: number) {
    const i = Math.floor(x), j = Math.floor(z)
    if (!this.inBounds(i, j)) return -1
    return j * this.S + i
  }
  isWalkable(x: number, z: number) {
    const k = this.idx(x, z)
    return k >= 0 && this.walk[k] === 1 && this.block[k] === 0
  }
  isWallAt(x: number, z: number) {
    const k = this.idx(x, z)
    return k < 0 || this.walk[k] === 0
  }
  brushAt(x: number, z: number) {
    const k = this.idx(x, z)
    return k < 0 ? 0 : this.brush[k]
  }
  inRiver(x: number, z: number) {
    const k = this.idx(x, z)
    return k >= 0 && this.river[k] === 1
  }

  heightAt(x: number, z: number) {
    const S = this.S, V = S + 1
    x = clamp(x, 0, S - 0.001); z = clamp(z, 0, S - 0.001)
    const i = Math.floor(x), j = Math.floor(z)
    const fx = x - i, fz = z - j
    const h = this.heights
    const a = h[j * V + i], b = h[j * V + i + 1], c = h[(j + 1) * V + i], d = h[(j + 1) * V + i + 1]
    return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz
  }

  blockCircle(x: number, z: number, r: number, v = 1) {
    const S = this.S
    for (let j = Math.floor(z - r); j <= Math.ceil(z + r); j++) for (let i = Math.floor(x - r); i <= Math.ceil(x + r); i++) {
      if (!this.inBounds(i, j)) continue
      const dx = i + 0.5 - x, dz = j + 0.5 - z
      if (dx * dx + dz * dz <= r * r) this.block[j * S + i] = v
    }
  }

  private passable(k: number) { return this.walk[k] === 1 && this.block[k] === 0 }

  /** grid line of sight; walls only when wallsOnly, else also dynamic blockers */
  los(x0: number, z0: number, x1: number, z1: number, wallsOnly = false): boolean {
    const S = this.S
    let i = Math.floor(x0), j = Math.floor(z0)
    const ie = Math.floor(x1), je = Math.floor(z1)
    const dx = x1 - x0, dz = z1 - z0
    const si = dx > 0 ? 1 : -1, sj = dz > 0 ? 1 : -1
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity
    const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity
    let tmx = dx !== 0 ? (dx > 0 ? i + 1 - x0 : x0 - i) * tdx : Infinity
    let tmz = dz !== 0 ? (dz > 0 ? j + 1 - z0 : z0 - j) * tdz : Infinity
    let n = Math.abs(ie - i) + Math.abs(je - j) + 2
    while (n-- > 0) {
      if (!this.inBounds(i, j)) return false
      const k = j * S + i
      if (this.walk[k] === 0 || (!wallsOnly && this.block[k] !== 0)) return false
      if (i === ie && j === je) return true
      if (tmx < tmz) { tmx += tdx; i += si } else { tmz += tdz; j += sj }
    }
    return true
  }

  /** thick LOS: checks three parallel rays offset by r */
  losWide(x0: number, z0: number, x1: number, z1: number, r: number) {
    if (!this.los(x0, z0, x1, z1)) return false
    const dx = x1 - x0, dz = z1 - z0
    const l = Math.hypot(dx, dz)
    if (l < 1e-6) return true
    const px = (-dz / l) * r, pz = (dx / l) * r
    return this.los(x0 + px, z0 + pz, x1 + px, z1 + pz) && this.los(x0 - px, z0 - pz, x1 - px, z1 - pz)
  }

  nearestWalkable(x: number, z: number, maxR = 14): [number, number] | null {
    if (this.isWalkable(x, z)) return [x, z]
    const ci = Math.floor(x), cj = Math.floor(z)
    let best: [number, number] | null = null, bd = Infinity
    for (let r = 1; r <= maxR; r++) {
      for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue
        if (!this.inBounds(i, j) || !this.passable(j * this.S + i)) continue
        const d = (i + 0.5 - x) ** 2 + (j + 0.5 - z) ** 2
        if (d < bd) { bd = d; best = [i + 0.5, j + 0.5] }
      }
      if (best) return best
    }
    return null
  }

  /** walk along the segment and return the furthest walkable point (for dashes) */
  castWalkable(x0: number, z0: number, x1: number, z1: number): [number, number] {
    const l = Math.hypot(x1 - x0, z1 - z0)
    const steps = Math.max(1, Math.ceil(l / 0.25))
    let lx = x0, lz = z0
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t
      if (!this.isWalkable(x, z)) break
      lx = x; lz = z
    }
    return [lx, lz]
  }

  /** A* with octile heuristic followed by string-pulling. Returns waypoints excluding start. */
  findPath(sx: number, sz: number, tx: number, tz: number): [number, number][] | null {
    const S = this.S
    const goal = this.nearestWalkable(tx, tz)
    if (!goal) return null
    ;[tx, tz] = goal
    let start = this.nearestWalkable(sx, sz, 4)
    if (!start) return null
    if (this.los(start[0], start[1], tx, tz)) return [[tx, tz]]
    const si = Math.floor(start[0]), sj = Math.floor(start[1])
    const gi = Math.floor(tx), gj = Math.floor(tz)
    const sk = sj * S + si, gk = gj * S + gi
    const gen = ++this.gen
    const g = this.g, came = this.came, stamp = this.stamp, closed = this.closed
    const heap = new Heap()
    const h = (i: number, j: number) => {
      const dx = Math.abs(i - gi), dz = Math.abs(j - gj)
      return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz)
    }
    stamp[sk] = gen; g[sk] = 0; came[sk] = -1
    heap.push(sk, h(si, sj))
    let found = false
    let iter = 0
    const DI = [1, -1, 0, 0, 1, 1, -1, -1]
    const DJ = [0, 0, 1, -1, 1, -1, 1, -1]
    while (heap.size) {
      const k = heap.pop()
      if (closed[k] === gen) continue
      closed[k] = gen
      if (k === gk) { found = true; break }
      if (++iter > 40000) break
      const i = k % S, j = (k - i) / S
      for (let d = 0; d < 8; d++) {
        const ni = i + DI[d], nj = j + DJ[d]
        if (ni < 0 || nj < 0 || ni >= S || nj >= S) continue
        const nk = nj * S + ni
        if (!this.passable(nk) || closed[nk] === gen) continue
        if (d >= 4 && (!this.passable(j * S + ni) || !this.passable(nj * S + i))) continue
        const ng = g[k] + (d >= 4 ? Math.SQRT2 : 1)
        if (stamp[nk] !== gen || ng < g[nk]) {
          stamp[nk] = gen; g[nk] = ng; came[nk] = k
          heap.push(nk, ng + h(ni, nj) * 1.001)
        }
      }
    }
    if (!found) return null
    const cells: [number, number][] = []
    for (let k = gk; k !== -1; k = came[k]) {
      const i = k % S, j = (k - i) / S
      cells.push([i + 0.5, j + 0.5])
    }
    cells.reverse()
    cells[cells.length - 1] = [tx, tz]
    // string pulling
    const out: [number, number][] = []
    let cx = start[0], cz = start[1]
    let idx = 0
    while (idx < cells.length - 1) {
      let far = idx + 1
      for (let k = cells.length - 1; k > idx + 1; k--) {
        if (this.losWide(cx, cz, cells[k][0], cells[k][1], 0.35)) { far = k; break }
      }
      out.push(cells[far])
      cx = cells[far][0]; cz = cells[far][1]
      idx = far
    }
    if (out.length === 0) out.push([tx, tz])
    return out
  }
}

class Heap {
  private k: number[] = []
  private f: number[] = []
  get size() { return this.k.length }
  push(key: number, pri: number) {
    const k = this.k, f = this.f
    k.push(key); f.push(pri)
    let i = k.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (f[p] <= f[i]) break
      ;[k[p], k[i]] = [k[i], k[p]];[f[p], f[i]] = [f[i], f[p]]
      i = p
    }
  }
  pop(): number {
    const k = this.k, f = this.f
    const top = k[0]
    const lk = k.pop()!, lf = f.pop()!
    if (k.length) {
      k[0] = lk; f[0] = lf
      let i = 0
      const n = k.length
      for (;;) {
        const l = i * 2 + 1, r = l + 1
        let m = i
        if (l < n && f[l] < f[m]) m = l
        if (r < n && f[r] < f[m]) m = r
        if (m === i) break
        ;[k[m], k[i]] = [k[i], k[m]];[f[m], f[i]] = [f[i], f[m]]
        i = m
      }
    }
    return top
  }
}
