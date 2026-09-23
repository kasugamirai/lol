import { lerpAngle } from '../util/math'

/** Snapshot interpolation buffer for remotely simulated units. Times are local ms. */
export class Interp {
  private t: number[] = []
  private x: number[] = []
  private z: number[] = []
  private f: number[] = []
  lastTp = -1

  push(t: number, x: number, z: number, f: number, tp = 0) {
    if (tp !== this.lastTp) {
      // teleport (flash / recall / respawn): snap
      this.lastTp = tp
      this.reset(t, x, z, f)
      return
    }
    const n = this.t.length
    if (n && t <= this.t[n - 1]) t = this.t[n - 1] + 1
    this.t.push(t); this.x.push(x); this.z.push(z); this.f.push(f)
    if (this.t.length > 12) { this.t.shift(); this.x.shift(); this.z.shift(); this.f.shift() }
  }

  reset(t: number, x: number, z: number, f: number) {
    this.t = [t]; this.x = [x]; this.z = [z]; this.f = [f]
  }

  get empty() { return this.t.length === 0 }

  /** returns [x, z, f, moving] at render time rt */
  sample(rt: number, out: { x: number; z: number; f: number; v: number }) {
    const n = this.t.length
    if (!n) return false
    const T = this.t
    if (rt <= T[0] || n === 1) {
      out.x = this.x[0]; out.z = this.z[0]; out.f = this.f[0]; out.v = 0
      if (n === 1) return true
      return true
    }
    for (let i = n - 1; i > 0; i--) {
      if (T[i - 1] <= rt) {
        const a = i - 1
        const span = T[i] - T[a]
        if (rt <= T[i]) {
          const k = span > 0 ? (rt - T[a]) / span : 1
          out.x = this.x[a] + (this.x[i] - this.x[a]) * k
          out.z = this.z[a] + (this.z[i] - this.z[a]) * k
          out.f = lerpAngle(this.f[a], this.f[i], k)
          out.v = span > 0 ? Math.hypot(this.x[i] - this.x[a], this.z[i] - this.z[a]) / (span / 1000) : 0
          return true
        }
        // beyond the newest sample: extrapolate a little
        const ext = Math.min(rt - T[i], 120)
        const vx = span > 0 ? (this.x[i] - this.x[a]) / span : 0
        const vz = span > 0 ? (this.z[i] - this.z[a]) / span : 0
        out.x = this.x[i] + vx * ext
        out.z = this.z[i] + vz * ext
        out.f = this.f[i]
        out.v = rt - T[i] > 250 ? 0 : Math.hypot(vx, vz) * 1000
        return true
      }
    }
    return true
  }
}
