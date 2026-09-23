export type P2 = [number, number]

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
export const dist2 = (ax: number, az: number, bx: number, bz: number) => {
  const dx = bx - ax, dz = bz - az
  return dx * dx + dz * dz
}
export const dist = (ax: number, az: number, bx: number, bz: number) => Math.sqrt(dist2(ax, az, bx, bz))

/** facing angle convention: direction = (sin f, cos f) in (x, z) — matches three.js rotation.y for +z-forward models */
export const angleTo = (ax: number, az: number, bx: number, bz: number) => Math.atan2(bx - ax, bz - az)

export function wrapAngle(a: number) {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}
export function lerpAngle(a: number, b: number, t: number) {
  return a + wrapAngle(b - a) * t
}
export function turnToward(a: number, b: number, maxStep: number) {
  const d = wrapAngle(b - a)
  if (Math.abs(d) <= maxStep) return b
  return a + Math.sign(d) * maxStep
}

/** squared distance from point p to segment ab */
export function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const abx = bx - ax, abz = bz - az
  const l2 = abx * abx + abz * abz
  let t = l2 > 0 ? ((px - ax) * abx + (pz - az) * abz) / l2 : 0
  t = clamp(t, 0, 1)
  const cx = ax + abx * t, cz = az + abz * t
  return dist2(px, pz, cx, cz)
}

export function polylineLength(pts: P2[]) {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])
  return s
}

export function pointAlong(pts: P2[], s: number): P2 {
  if (s <= 0) return [pts[0][0], pts[0][1]]
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i]
    const l = dist(ax, az, bx, bz)
    if (s <= l) {
      const t = l > 0 ? s / l : 0
      return [ax + (bx - ax) * t, az + (bz - az) * t]
    }
    s -= l
  }
  const last = pts[pts.length - 1]
  return [last[0], last[1]]
}

/** arc-length parameter of the closest point on polyline to p */
export function closestS(pts: P2[], px: number, pz: number) {
  let best = Infinity, bestS = 0, acc = 0
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i]
    const abx = bx - ax, abz = bz - az
    const l2 = abx * abx + abz * abz
    const l = Math.sqrt(l2)
    let t = l2 > 0 ? ((px - ax) * abx + (pz - az) * abz) / l2 : 0
    t = clamp(t, 0, 1)
    const d = dist2(px, pz, ax + abx * t, az + abz * t)
    if (d < best) { best = d; bestS = acc + t * l }
    acc += l
  }
  return bestS
}

export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hash2(x: number, z: number) {
  let h = (x * 374761393 + z * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** smooth value noise in [0,1] */
export function vnoise(x: number, z: number) {
  const xi = Math.floor(x), zi = Math.floor(z)
  const xf = x - xi, zf = z - zi
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf)
  const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1)
  return lerp(lerp(a, b, u), lerp(c, d, u), v)
}
export function fbm(x: number, z: number, oct = 3) {
  let s = 0, amp = 0.5, f = 1, n = 0
  for (let i = 0; i < oct; i++) { s += vnoise(x * f, z * f) * amp; n += amp; amp *= 0.5; f *= 2 }
  return s / n
}

export function randId(n = 8) {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789'
  let s = ''
  const arr = new Uint8Array(n)
  crypto.getRandomValues(arr)
  for (let i = 0; i < n; i++) s += abc[arr[i] % abc.length]
  return s
}
