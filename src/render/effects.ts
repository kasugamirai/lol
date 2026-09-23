import * as THREE from 'three'
import type { World, Effect, Projectile } from '../game/world'
import { fadeMat, glow } from './mats'
import { G } from './models'

const ringGeo = new THREE.RingGeometry(0.9, 1, 48)
const thinRingGeo = new THREE.RingGeometry(0.96, 1, 64)
const discGeo = new THREE.CircleGeometry(1, 40)
const sphGeo = new THREE.SphereGeometry(1, 14, 10)
const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true)
const planeGeo = new THREE.PlaneGeometry(1, 1)
const torGeo = new THREE.TorusGeometry(1, 0.06, 6, 32)
const arcGeo = new THREE.TorusGeometry(1, 0.08, 4, 16, Math.PI * 0.9)
const boxGeo = new THREE.BoxGeometry(1, 1, 1)
const octGeo = new THREE.OctahedronGeometry(1, 0)
const dodGeo = new THREE.DodecahedronGeometry(1, 0)
const flat = (m: THREE.Object3D) => { m.rotation.x = -Math.PI / 2; return m }

// ---------------------------------------------------------------- particles (instanced, additive)
export class Particles {
  mesh: THREE.InstancedMesh
  private d: Float32Array
  private n = 0
  private readonly N: number
  private m4 = new THREE.Matrix4()
  private col = new THREE.Color()
  constructor(cap = 1600) {
    this.N = cap
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 6, 4), mat, cap)
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    this.mesh.setColorAt(0, new THREE.Color(0))
    this.d = new Float32Array(cap * 13)
  }
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, color: number, grav = 0) {
    if (this.n >= this.N) return
    const o = this.n++ * 13
    const c = this.col.set(color)
    const d = this.d
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz
    d[o + 6] = life; d[o + 7] = life; d[o + 8] = size; d[o + 9] = c.r; d[o + 10] = c.g; d[o + 11] = c.b; d[o + 12] = grav
  }
  burst(x: number, y: number, z: number, n: number, speed: number, life: number, size: number, color: number, up = 1, grav = 6) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const s = speed * (0.4 + Math.random() * 0.6)
      this.spawn(x, y, z, Math.cos(a) * s, (0.3 + Math.random()) * speed * up, Math.sin(a) * s, life * (0.6 + Math.random() * 0.4), size * (0.6 + Math.random() * 0.6), color, grav)
    }
  }
  update(dt: number) {
    const d = this.d
    let w = 0
    for (let i = 0; i < this.n; i++) {
      const o = i * 13
      d[o + 6] -= dt
      if (d[o + 6] <= 0) continue
      d[o + 4] -= d[o + 12] * dt
      d[o] += d[o + 3] * dt; d[o + 1] += d[o + 4] * dt; d[o + 2] += d[o + 5] * dt
      if (w !== i) d.copyWithin(w * 13, o, o + 13)
      w++
    }
    this.n = w
    for (let i = 0; i < w; i++) {
      const o = i * 13
      const k = d[o + 6] / d[o + 7]
      const s = d[o + 8] * (0.35 + 0.65 * k)
      this.m4.makeScale(s, s, s)
      this.m4.setPosition(d[o], d[o + 1], d[o + 2])
      this.mesh.setMatrixAt(i, this.m4)
      this.col.setRGB(d[o + 9] * k, d[o + 10] * k, d[o + 11] * k)
      this.mesh.setColorAt(i, this.col)
    }
    this.mesh.count = w
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }
}

interface FxView {
  obj: THREE.Object3D
  mats: THREE.Material[]
  lastSpawn?: number
}

export class FxLayer {
  group = new THREE.Group()
  particles = new Particles()
  private views = new Map<Effect, FxView>()
  private proj = new Map<Projectile, { obj: THREE.Object3D; last: number; spin: number }>()
  private projMatCache = new Map<string, THREE.Material>()

  constructor(private heightAt: (x: number, z: number) => number, private isVisible: (x: number, z: number) => boolean) {
    this.group.add(this.particles.mesh)
  }

  private make(e: Effect): FxView {
    const mats: THREE.Material[] = []
    const M = (color: number, op = 1, add = true, side: THREE.Side = THREE.FrontSide) => { const m = fadeMat(color, op, add, side); mats.push(m); return m }
    const g = new THREE.Group()
    switch (e.kind) {
      case 'telegraph': {
        const ring = flat(new THREE.Mesh(ringGeo, M(e.color, 0.9)))
        const disc = flat(new THREE.Mesh(discGeo, M(e.color, 0.16, false)))
        const fill = flat(new THREE.Mesh(discGeo, M(e.color, 0.28)))
        fill.name = 'fill'
        g.add(ring, disc, fill)
        break
      }
      case 'burst': case 'nova': {
        const ring = flat(new THREE.Mesh(ringGeo, M(e.color, 1)))
        ring.name = 'ring'
        const disc = flat(new THREE.Mesh(discGeo, M(e.color, 0.5)))
        disc.name = 'disc'
        g.add(ring, disc)
        if (e.kind === 'nova') {
          const wall = new THREE.Mesh(cylGeo, M(e.color, 0.35, true, THREE.DoubleSide))
          wall.name = 'wall'
          g.add(wall)
        }
        break
      }
      case 'explosion': {
        const s = new THREE.Mesh(sphGeo, M(e.color, 0.7))
        s.name = 'ball'
        const core = new THREE.Mesh(sphGeo, M(0xffffff, 0.8))
        core.name = 'core'
        const ring = flat(new THREE.Mesh(ringGeo, M(e.color, 1)))
        ring.name = 'ring'
        g.add(s, core, ring)
        this.particles.burst(e.x, this.heightAt(e.x, e.z) + 0.5, e.z, Math.min(40, 10 + e.r * 6), 3 + e.r * 2, 0.8, 0.12 + e.r * 0.03, e.color, 1.2, 6)
        break
      }
      case 'zone': {
        const disc = flat(new THREE.Mesh(discGeo, M(e.color, 0.28)))
        disc.name = 'disc'
        const ring = flat(new THREE.Mesh(ringGeo, M(e.color, 0.9)))
        g.add(disc, ring)
        break
      }
      case 'line': {
        const pl = flat(new THREE.Mesh(planeGeo, M(e.color, 0.2, false)))
        pl.name = 'fill'
        const edge = flat(new THREE.Mesh(planeGeo, M(e.color, 0.55)))
        edge.name = 'edge'
        g.add(pl, edge)
        break
      }
      case 'beam': {
        const pl = flat(new THREE.Mesh(planeGeo, M(e.color, 0.9)))
        pl.name = 'fill'
        const core = flat(new THREE.Mesh(planeGeo, M(0xffffff, 0.9)))
        core.name = 'core'
        const glowBox = new THREE.Mesh(boxGeo, M(e.color, 0.35))
        glowBox.name = 'box'
        g.add(pl, core, glowBox)
        break
      }
      case 'cone': {
        const half = e.data?.half ?? 0.5
        const geo = new THREE.CircleGeometry(1, 24, Math.PI / 2 - half, half * 2)
        const m = flat(new THREE.Mesh(geo, M(e.color, 0.4)))
        m.name = 'sector'
        g.add(m)
        break
      }
      case 'flash': {
        const s = new THREE.Mesh(sphGeo, M(e.color, 0.8))
        s.name = 'ball'
        const r = flat(new THREE.Mesh(ringGeo, M(e.color, 1)))
        r.name = 'ring'
        g.add(s, r)
        this.particles.burst(e.x, this.heightAt(e.x, e.z) + 1, e.z, 14, 4, 0.5, 0.1, e.color, 0.6, 0)
        break
      }
      case 'heal': case 'global': {
        const col = new THREE.Mesh(cylGeo, M(e.color, 0.35, true, THREE.DoubleSide))
        col.name = 'col'
        const r = flat(new THREE.Mesh(ringGeo, M(e.color, 0.9)))
        r.name = 'ring'
        g.add(col, r)
        break
      }
      case 'shieldfx': {
        const s = new THREE.Mesh(sphGeo, M(e.data?.gold ? 0xffd700 : e.color, 0.22))
        s.name = 'ball'
        const r = flat(new THREE.Mesh(ringGeo, M(e.color, 0.7)))
        g.add(s, r)
        break
      }
      case 'levelup': {
        const r = flat(new THREE.Mesh(ringGeo, M(e.color, 1)))
        r.name = 'ring'
        const r2 = flat(new THREE.Mesh(thinRingGeo, M(0xffffff, 0.8)))
        r2.name = 'ring2'
        g.add(r, r2)
        break
      }
      case 'mark': {
        const t = new THREE.Mesh(torGeo, M(e.color, 0.95))
        t.rotation.x = Math.PI / 2
        t.name = 'tor'
        for (let i = 0; i < 4; i++) {
          const sp = new THREE.Mesh(octGeo, M(e.color, 0.9))
          sp.scale.set(0.12, 0.3, 0.12)
          sp.position.set(Math.cos(i * Math.PI / 2), 0, Math.sin(i * Math.PI / 2))
          t.add(sp)
        }
        g.add(t)
        break
      }
      case 'spin': {
        const t = new THREE.Mesh(torGeo, M(e.color, 0.8))
        t.rotation.x = Math.PI / 2
        t.name = 'tor'
        for (let i = 0; i < 3; i++) {
          const bl = new THREE.Mesh(boxGeo, M(0xffffff, 0.8))
          bl.scale.set(0.6, 0.05, 0.12)
          bl.position.set(Math.cos(i * 2.09) * 0.8, Math.sin(i * 2.09) * 0.8, 0)
          bl.rotation.z = i * 2.09
          t.add(bl)
        }
        g.add(t)
        break
      }
      case 'hitspark': {
        const s = new THREE.Mesh(octGeo, M(e.color, 0.9))
        s.name = 'ball'
        g.add(s)
        this.particles.burst(e.x, this.heightAt(e.x, e.z) + 1.1, e.z, 6, 3, 0.3, 0.07, e.color, 0.5, 0)
        break
      }
      case 'pillar': {
        const c = new THREE.Mesh(cylGeo, M(e.color, 0.7, true, THREE.DoubleSide))
        c.name = 'col'
        const core = new THREE.Mesh(cylGeo, M(0xffffff, 0.8, true, THREE.DoubleSide))
        core.name = 'core'
        const r = flat(new THREE.Mesh(ringGeo, M(e.color, 1)))
        r.name = 'ring'
        g.add(c, core, r)
        break
      }
      case 'death': {
        this.particles.burst(e.x, this.heightAt(e.x, e.z) + 0.8, e.z, 12, 1.5, 1.0, 0.25, 0x666677, 0.8, -0.5)
        break
      }
      case 'slash': {
        const a = new THREE.Mesh(arcGeo, M(e.color, 0.9))
        a.name = 'arc'
        a.rotation.set(Math.PI / 2 - 0.3, 0, 0)
        const holder = new THREE.Group()
        holder.rotation.y = (e.dir ?? 0) - Math.PI / 2
        holder.add(a)
        g.add(holder)
        break
      }
      case 'click': case 'ping': case 'ring': {
        const r = flat(new THREE.Mesh(ringGeo, M(e.color, 1)))
        r.name = 'ring'
        g.add(r)
        if (e.kind === 'click') {
          const r2 = flat(new THREE.Mesh(thinRingGeo, M(e.color, 1)))
          r2.name = 'ring2'
          g.add(r2)
        }
        if (e.kind === 'ping') {
          const p = new THREE.Mesh(octGeo, M(e.color, 0.9))
          p.scale.set(0.35, 0.8, 0.35)
          p.name = 'pin'
          g.add(p)
        }
        break
      }
      case 'buffglow': {
        const r = flat(new THREE.Mesh(ringGeo, M(e.color, 0.6)))
        r.name = 'ring'
        g.add(r)
        break
      }
      case 'trail': default:
        break
    }
    this.group.add(g)
    return { obj: g, mats }
  }

  private upd(e: Effect, v: FxView, w: World, t: number, dt: number) {
    const p = Math.min(1, (w.now - e.t0) / Math.max(0.001, e.dur))
    let x = e.x, z = e.z
    if (e.follow && !e.follow.dead) { x = e.follow.x; z = e.follow.z }
    const y = this.heightAt(x, z)
    const o = v.obj
    o.position.set(x, y + 0.06, z)
    const get = (n: string) => o.getObjectByName(n) as THREE.Mesh | undefined
    const op = (m: THREE.Mesh | undefined, a: number) => { if (m) (m.material as THREE.MeshBasicMaterial).opacity = a }
    const fade = 1 - p
    switch (e.kind) {
      case 'telegraph': {
        o.scale.set(e.r, 1, e.r)
        const f = get('fill')!
        f.scale.setScalar(Math.max(0.01, p))
        break
      }
      case 'burst': case 'nova': {
        const k = e.kind === 'nova' ? 0.2 + p * 0.95 : 0.6 + p * 0.5
        o.scale.set(e.r * k, 1, e.r * k)
        op(get('ring'), fade)
        op(get('disc'), 0.45 * fade * fade)
        const wall = get('wall')
        if (wall) { wall.scale.set(1, 1.2 * fade + 0.2, 1); wall.position.y = 0.6 * fade; op(wall, 0.35 * fade) }
        break
      }
      case 'explosion': {
        const ball = get('ball')!, core = get('core')!, ring = get('ring')!
        const k = 0.35 + Math.pow(p, 0.5) * 0.8
        ball.scale.setScalar(e.r * k * 0.8)
        ball.position.y = e.r * 0.3
        core.scale.setScalar(e.r * k * 0.45 * fade)
        core.position.y = e.r * 0.3
        ring.scale.setScalar(e.r * (0.4 + p * 0.9))
        op(ball, 0.7 * fade * fade); op(core, fade); op(ring, fade)
        break
      }
      case 'zone': {
        o.scale.set(e.r, 1, e.r)
        const pulse = 0.22 + Math.sin(t * 8) * 0.06
        op(get('disc'), pulse * Math.min(1, (1 - p) * 6))
        if (Math.random() < dt * 20) {
          const a = Math.random() * Math.PI * 2, rr = Math.random() * e.r
          this.particles.spawn(x + Math.cos(a) * rr, y + 0.2, z + Math.sin(a) * rr, 0, 1.5 + Math.random(), 0, 0.7, 0.12, e.color, -0.5)
        }
        break
      }
      case 'line': case 'beam': {
        const len = e.len ?? 5, wd = (e.r ?? 1) * 2
        const dir = e.dir ?? 0
        o.position.set(e.x, this.heightAt(e.x, e.z) + 0.08, e.z)
        o.rotation.y = dir
        const fill = get('fill')!
        fill.scale.set(wd, len, 1)
        fill.position.set(0, 0, len / 2)
        if (e.kind === 'line') {
          const edge = get('edge')!
          edge.scale.set(wd * Math.min(1, p), len, 1)
          edge.position.set(0, 0.01, len / 2)
          op(edge, 0.35)
        } else {
          const core = get('core')!, box = get('box')!
          const k = p < 0.15 ? p / 0.15 : fade
          fill.scale.set(wd * (0.6 + 0.6 * k), len, 1)
          core.scale.set(wd * 0.3 * k, len, 1)
          core.position.set(0, 0.02, len / 2)
          box.scale.set(wd * 0.5 * k + 0.01, 1.4 * k + 0.01, len)
          box.position.set(0, 0.8, len / 2)
          op(fill, 0.85 * k); op(core, 0.9 * k); op(box, 0.35 * k)
        }
        break
      }
      case 'cone': {
        o.rotation.y = (e.dir ?? 0) + Math.PI
        o.scale.set(e.r, 1, e.r)
        op(get('sector'), 0.45 * fade)
        break
      }
      case 'flash': {
        const ball = get('ball')!
        ball.scale.setScalar(e.r * (0.3 + p))
        ball.position.y = 1
        op(ball, 0.8 * fade)
        const r = get('ring')!
        r.scale.setScalar(e.r * (0.5 + p * 1.2))
        op(r, fade)
        break
      }
      case 'heal': case 'global': {
        const col = get('col')!
        const h = e.kind === 'global' ? 6 : 2.6
        col.scale.set(e.r * (1 - p * 0.3), h, e.r * (1 - p * 0.3))
        col.position.y = h / 2
        op(col, 0.3 * fade)
        const r = get('ring')!
        r.scale.setScalar(e.r * (0.6 + p * 0.6))
        op(r, fade)
        if (Math.random() < dt * 30) this.particles.spawn(x + (Math.random() - 0.5) * e.r * 1.5, y + 0.3, z + (Math.random() - 0.5) * e.r * 1.5, 0, 2.5, 0, 0.8, 0.09, e.color, 0)
        break
      }
      case 'shieldfx': {
        const b = get('ball')!
        b.scale.setScalar(e.r * (1 + Math.sin(t * 6) * 0.04))
        b.position.y = 1.1
        op(b, 0.22 * Math.min(1, (1 - p) * 5))
        break
      }
      case 'levelup': {
        const r = get('ring')!, r2 = get('ring2')!
        r.position.y = p * 2.8
        r.scale.setScalar(e.r * (1.2 - p * 0.4))
        r2.position.y = p * 1.6
        r2.scale.setScalar(e.r * (1 + p * 0.6))
        op(r, fade); op(r2, fade)
        if (Math.random() < dt * 25) this.particles.spawn(x + (Math.random() - 0.5) * 1.4, y + 0.2, z + (Math.random() - 0.5) * 1.4, 0, 3, 0, 0.6, 0.08, 0xffe08a, 0)
        break
      }
      case 'mark': {
        const tor = get('tor')!
        const h = e.follow ? e.follow.height + 0.7 : 2.8
        tor.position.y = h
        tor.rotation.z = t * 3
        tor.scale.setScalar(e.r * (1 + Math.sin(t * 10) * 0.08) * (p > 0.85 ? 1 + (p - 0.85) * 4 : 1))
        break
      }
      case 'spin': {
        const tor = get('tor')!
        tor.position.y = 1.0
        tor.rotation.z = -t * 14
        tor.scale.setScalar(e.r)
        op(tor, 0.7 * Math.min(1, (1 - p) * 6))
        break
      }
      case 'hitspark': {
        const b = get('ball')!
        b.position.y = 1.1
        b.scale.setScalar(0.25 + p * 0.5)
        b.rotation.y = t * 10
        op(b, fade)
        break
      }
      case 'pillar': {
        const c = get('col')!, core = get('core')!, r = get('ring')!
        const k = p < 0.2 ? p / 0.2 : fade
        c.scale.set(e.r * k, 14, e.r * k)
        c.position.y = 7
        core.scale.set(e.r * 0.35 * k, 14, e.r * 0.35 * k)
        core.position.y = 7
        r.scale.setScalar(e.r * (1 + p))
        op(c, 0.6 * k); op(core, 0.9 * k); op(r, fade)
        break
      }
      case 'slash': {
        const a = get('arc')!
        a.scale.setScalar(e.r * (0.7 + p * 0.5))
        a.position.y = 1.1
        op(a, fade)
        break
      }
      case 'click': {
        const r = get('ring')!, r2 = get('ring2')
        r.scale.setScalar(e.r * (1 - p * 0.7))
        op(r, fade)
        if (r2) { r2.scale.setScalar(e.r * 0.5 * (1 - p * 0.5)); op(r2, fade) }
        break
      }
      case 'ping': {
        const r = get('ring')!
        const k = (p * 3) % 1
        r.scale.setScalar(e.r * (0.4 + k * 1.4))
        op(r, 1 - k)
        const pin = get('pin')!
        pin.position.y = 1.4 + Math.sin(t * 6) * 0.2
        pin.rotation.y = t * 3
        break
      }
      case 'ring': {
        const r = get('ring')!
        r.scale.setScalar(e.r * (0.5 + p))
        op(r, fade)
        break
      }
      case 'buffglow': {
        const r = get('ring')!
        r.scale.setScalar(e.r * (0.9 + Math.sin(t * 7) * 0.1))
        op(r, 0.6 * Math.min(1, (1 - p) * 5))
        if (Math.random() < dt * 12) this.particles.spawn(x + (Math.random() - 0.5), y + 0.2, z + (Math.random() - 0.5), 0, 1.6, 0, 0.5, 0.07, e.color, 0)
        break
      }
      case 'trail': {
        if (!e.follow) break
        this.particles.spawn(x, y + 1.0, z, 0, 0, 0, 0.35, 0.45, e.color, 0)
        this.particles.spawn(x, y + 0.5, z, 0, 0, 0, 0.3, 0.35, e.color, 0)
        break
      }
    }
  }

  update(w: World, dt: number, t: number) {
    // effects
    const alive = new Set(w.effects)
    for (const [e, v] of this.views) {
      if (!alive.has(e)) {
        this.group.remove(v.obj)
        v.mats.forEach(m => m.dispose())
        this.views.delete(e)
      }
    }
    for (const e of w.effects) {
      const fx = e.follow ? e.follow.x : e.x, fz = e.follow ? e.follow.z : e.z
      const vis = !e.follow ? this.isVisible(fx, fz) : w.visibleToMe(e.follow)
      let v = this.views.get(e)
      if (!v) {
        if (!vis && e.kind !== 'telegraph') continue
        v = this.make(e)
        this.views.set(e, v)
      }
      v.obj.visible = vis || e.kind === 'telegraph' && e.team === w.myTeam
      if (v.obj.visible) this.upd(e, v, w, t, dt)
    }
    // projectiles
    const live = new Set(w.projectiles)
    for (const [p, v] of this.proj) {
      if (!live.has(p)) {
        this.group.remove(v.obj)
        this.proj.delete(p)
        if (p.anyHit || p.homing) this.particles.burst(p.x, this.heightAt(p.x, p.z) + p.y, p.z, 5, 2.5, 0.25, p.vis.size * 0.25, p.vis.color, 0.5, 0)
      }
    }
    for (const p of w.projectiles) {
      let v = this.proj.get(p)
      if (!v) {
        v = { obj: this.makeProj(p), last: 0, spin: Math.random() * 6 }
        this.group.add(v.obj)
        this.proj.set(p, v)
      }
      const vis = this.isVisible(p.x, p.z) || p.team === w.myTeam
      v.obj.visible = vis
      if (!vis) continue
      let y = this.heightAt(p.x, p.z) + p.y
      if (p.homing) {
        const ty = this.heightAt(p.homing.x, p.homing.z) + Math.min(p.homing.height * 0.6, 1.6)
        const d = Math.hypot(p.homing.x - p.x, p.homing.z - p.z)
        y = ty + (y - ty) * Math.min(1, d / 5)
      }
      v.obj.position.set(p.x, y, p.z)
      const dir = Math.atan2(p.dx, p.dz)
      v.obj.rotation.y = dir
      if (p.vis.kind === 'blade' || p.vis.kind === 'rock') v.obj.rotation.x = (v.spin += dt * 16)
      if (p.vis.trail && t - v.last > 0.016) {
        v.last = t
        this.particles.spawn(p.x, y, p.z, 0, 0, 0, 0.35, p.vis.size * 0.35, p.vis.color, 0)
      }
    }
    this.particles.update(dt)
  }

  private pm(color: number, op = 1, add = true) {
    const key = `${color}|${op}|${add}`
    let m = this.projMatCache.get(key)
    if (!m) { m = glow(color, op, add, !add); this.projMatCache.set(key, m) }
    return m
  }

  private makeProj(p: Projectile): THREE.Object3D {
    const s = p.vis.size
    const g = new THREE.Group()
    switch (p.vis.kind) {
      case 'arrow': case 'spear': {
        const shaft = new THREE.Mesh(boxGeo, this.pm(p.vis.color, 1, false))
        shaft.scale.set(0.07 * Math.max(1, s), 0.07 * Math.max(1, s), 1.1 * s + 0.4)
        const tip = new THREE.Mesh(octGeo, this.pm(0xffffff, 1, false))
        tip.scale.set(0.12 * s + 0.05, 0.12 * s + 0.05, 0.3 * s + 0.1)
        tip.position.z = 0.55 * s + 0.2
        const halo = new THREE.Mesh(sphGeo, this.pm(p.vis.color, 0.35))
        halo.scale.set(0.25 * s + 0.1, 0.25 * s + 0.1, 0.8 * s + 0.2)
        g.add(shaft, tip, halo)
        break
      }
      case 'blade': {
        const b = new THREE.Mesh(octGeo, this.pm(p.vis.color, 1, false))
        b.scale.set(0.45 * s, 0.06, 0.45 * s)
        const halo = new THREE.Mesh(sphGeo, this.pm(p.vis.color, 0.3))
        halo.scale.setScalar(0.45 * s)
        g.add(b, halo)
        break
      }
      case 'rock': {
        const r = new THREE.Mesh(dodGeo, new THREE.MeshLambertMaterial({ color: p.vis.color, flatShading: true }))
        r.scale.setScalar(0.45 * s)
        g.add(r)
        break
      }
      default: {
        const core = new THREE.Mesh(sphGeo, this.pm(p.vis.kind === 'tower' ? 0xffffff : p.vis.color, 1, false))
        core.scale.setScalar(0.45 * s)
        const halo = new THREE.Mesh(sphGeo, this.pm(p.vis.color, 0.45))
        halo.scale.setScalar(0.9 * s)
        g.add(core, halo)
        if (p.vis.kind === 'star' || p.vis.kind === 'ice') {
          const o = new THREE.Mesh(octGeo, this.pm(0xffffff, 0.9, false))
          o.scale.setScalar(0.6 * s)
          g.add(o)
        }
      }
    }
    return g
  }
}

export { G }
