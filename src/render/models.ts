import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { vcMat, vcMatFow, glow, TEAM_COLORS, TEAM_DARK, lambert } from './mats'
import type { ChampDef } from '../game/data/champions'
import type { MinionType } from '../game/data/units'
import type { MonsterType } from '../game/mapdef'

type V3 = [number, number, number]
export interface PartSpec { g: THREE.BufferGeometry; c: number; p?: V3; r?: V3; s?: V3 }

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3()
export function mergeParts(parts: PartSpec[]): THREE.BufferGeometry {
  const geos = parts.map(pt => {
    const g = pt.g.index ? pt.g.toNonIndexed() : pt.g.clone()
    if (g.attributes.uv) g.deleteAttribute('uv')
    if (g.attributes.uv1) g.deleteAttribute('uv1')
    _e.set(...(pt.r ?? [0, 0, 0]))
    _q.setFromEuler(_e)
    _m.compose(_v.set(...(pt.p ?? [0, 0, 0])), _q, _s.set(...(pt.s ?? [1, 1, 1])))
    g.applyMatrix4(_m)
    const n = g.attributes.position.count
    const col = new Float32Array(n * 3)
    const c = new THREE.Color(pt.c)
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    return g
  })
  const out = mergeGeometries(geos, false)!
  geos.forEach(g => g.dispose())
  out.computeBoundingSphere()
  return out
}

// primitive factories
export const G = {
  box: (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d),
  cyl: (rt: number, rb: number, h: number, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg),
  sph: (r: number, ws = 8, hs = 6) => new THREE.SphereGeometry(r, ws, hs),
  cone: (r: number, h: number, seg = 8) => new THREE.ConeGeometry(r, h, seg),
  ico: (r: number, d = 0) => new THREE.IcosahedronGeometry(r, d),
  dod: (r: number) => new THREE.DodecahedronGeometry(r, 0),
  oct: (r: number) => new THREE.OctahedronGeometry(r, 0),
  tor: (r: number, t: number, rs = 6, ts = 16, arc = Math.PI * 2) => new THREE.TorusGeometry(r, t, rs, ts, arc),
  /** back half of a sphere (hair / hood) */
  back: (r: number) => new THREE.SphereGeometry(r, 10, 8, Math.PI, Math.PI),
  /** top hemisphere (helmet) */
  cap: (r: number) => new THREE.SphereGeometry(r, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
}

function mesh(parts: PartSpec[], shadow = true, mat: THREE.Material = vcMat) {
  const m = new THREE.Mesh(mergeParts(parts), mat)
  m.castShadow = shadow
  return m
}

const SKIN = 0xf0c8a0
const DARK = 0x2a2a33
const STEEL = 0xd8dee8
const GOLD = 0xe8c050
const WOOD = 0x6a4a2a

// -------------------------------------------------------------------------------- champions

export interface AnimState {
  t: number
  moving: boolean
  speed: number
  atk: number // seconds since attack started (large if none)
  atkDur: number
  cast: number // seconds since cast started
  dead: number // seconds since death (-1 alive)
  stun: boolean
  air: number
  channel: boolean
}

export class ChampModel {
  root = new THREE.Group()
  body = new THREE.Group()
  legL = new THREE.Group()
  legR = new THREE.Group()
  armL = new THREE.Group()
  armR = new THREE.Group()
  head = new THREE.Group()
  robe: THREE.Object3D | null = null
  cape: THREE.Object3D | null = null
  float: THREE.Object3D[] = []
  scale = 1
  bow = false
  twin = false
  spear = false
  private meshes: THREE.Mesh[] = []

  constructor(public def: ChampDef) {
    const k = def.model
    const c1 = def.color, c2 = def.color2
    this.root.add(this.body)
    this.body.add(this.legL, this.legR, this.armL, this.armR, this.head)
    const hip = 0.95, sh = 1.62
    this.legL.position.set(-0.15, hip, 0)
    this.legR.position.set(0.15, hip, 0)
    this.armL.position.set(-0.42, sh, 0)
    this.armR.position.set(0.42, sh, 0)
    this.head.position.set(0, 1.98, 0)
    const add = (g: THREE.Group, parts: PartSpec[]) => { const m = mesh(parts); g.add(m); this.meshes.push(m); return m }
    const leg = (col: number, boot: number) => [
      { g: G.box(0.24, 0.62, 0.26), c: col, p: [0, -0.32, 0] as V3 },
      { g: G.box(0.27, 0.32, 0.34), c: boot, p: [0, -0.78, 0.04] as V3 },
    ]
    const arm = (col: number, hand = SKIN) => [
      { g: G.box(0.2, 0.55, 0.2), c: col, p: [0, -0.27, 0] as V3 },
      { g: G.sph(0.12, 6, 5), c: hand, p: [0, -0.62, 0] as V3 },
    ]
    const robed = k === 'mage' || k === 'frost' || k === 'ember'
    if (!robed && k !== 'golem') {
      add(this.legL, leg(c2, DARK))
      add(this.legR, leg(c2, DARK))
    }
    switch (k) {
      case 'blade': {
        add(this.body, [
          { g: G.box(0.66, 0.72, 0.4), c: c1, p: [0, 1.3, 0] },
          { g: G.box(0.7, 0.12, 0.44), c: DARK, p: [0, 0.98, 0] },
          { g: G.sph(0.2, 6, 5), c: c1, p: [-0.4, 1.66, 0], s: [1.2, 0.8, 1.1] },
          { g: G.sph(0.2, 6, 5), c: c1, p: [0.4, 1.66, 0], s: [1.2, 0.8, 1.1] },
          { g: G.box(0.3, 0.3, 0.05), c: GOLD, p: [0, 1.35, 0.21] },
        ])
        add(this.head, [
          { g: G.sph(0.27, 10, 8), c: SKIN },
          { g: G.cone(0.1, 0.35, 5), c: 0x7a1f10, p: [-0.12, 0.25, -0.05], r: [-0.4, 0, 0.4] },
          { g: G.cone(0.1, 0.4, 5), c: 0x7a1f10, p: [0.05, 0.28, -0.1], r: [-0.6, 0, -0.1] },
          { g: G.cone(0.1, 0.35, 5), c: 0x7a1f10, p: [0.16, 0.22, -0.02], r: [-0.3, 0, -0.5] },
          { g: G.box(0.56, 0.08, 0.5), c: c1, p: [0, 0.08, 0] },
          { g: G.box(0.07, 0.05, 0.02), c: DARK, p: [-0.09, 0.02, 0.26] },
          { g: G.box(0.07, 0.05, 0.02), c: DARK, p: [0.09, 0.02, 0.26] },
        ])
        add(this.armL, arm(c1))
        const a = add(this.armR, arm(c1))
        void a
        add(this.armR, [
          { g: G.box(0.1, 0.06, 1.35), c: STEEL, p: [0, -0.64, 0.75] },
          { g: G.box(0.38, 0.08, 0.1), c: GOLD, p: [0, -0.64, 0.1] },
          { g: G.box(0.07, 0.07, 0.22), c: WOOD, p: [0, -0.64, -0.03] },
        ])
        this.cape = add(this.body, [{ g: G.box(0.56, 0.95, 0.04), c: 0xc0301a, p: [0, -0.47, 0] }])
        this.cape.position.set(0, 1.66, -0.24)
        this.cape.children.length
        break
      }
      case 'archer': {
        this.bow = true
        add(this.body, [
          { g: G.cyl(0.3, 0.38, 0.8, 8), c: c1, p: [0, 1.32, 0] },
          { g: G.box(0.66, 0.1, 0.46), c: WOOD, p: [0, 1.0, 0] },
          { g: G.cyl(0.12, 0.12, 0.8, 6), c: WOOD, p: [0.12, 1.45, -0.3], r: [0.25, 0, -0.3] },
          { g: G.cone(0.05, 0.14, 4), c: 0xffffff, p: [0.24, 1.9, -0.4], r: [0.25, 0, -0.3] },
          { g: G.cone(0.05, 0.14, 4), c: 0xffffff, p: [0.16, 1.92, -0.4], r: [0.25, 0, -0.3] },
        ])
        add(this.head, [
          { g: G.sph(0.25, 10, 8), c: SKIN },
          { g: G.back(0.31), c: c1, p: [0, 0.04, 0.02] },
          { g: G.cap(0.3), c: c1, p: [0, 0.05, -0.01] },
          { g: G.cone(0.2, 0.4, 6), c: c1, p: [0, 0.14, -0.3], r: [-1.2, 0, 0] },
          { g: G.box(0.07, 0.05, 0.02), c: DARK, p: [-0.09, 0.0, 0.25] },
          { g: G.box(0.07, 0.05, 0.02), c: DARK, p: [0.09, 0.0, 0.25] },
        ])
        // facial opening: the hood covers the back; front skin sphere shows through scale trick
        add(this.armL, [...arm(c1), { g: G.tor(0.62, 0.035, 4, 14, Math.PI * 0.95), c: 0x7a4a24, p: [0, -0.62, 0.05], r: [0, Math.PI / 2, Math.PI / 2 + Math.PI * 0.025] },
          { g: G.box(0.015, 1.2, 0.015), c: 0xeeeeee, p: [0, -0.62, 0.05] }])
        add(this.armR, arm(c1))
        break
      }
      case 'mage': case 'frost': case 'ember': {
        const robeC = k === 'mage' ? c1 : k === 'frost' ? 0xdff6ff : 0x8a1e12
        const trim = k === 'mage' ? GOLD : k === 'frost' ? c1 : 0xff9a3a
        this.robe = add(this.body, [
          { g: G.cyl(0.3, 0.54, 1.02, 10), c: robeC, p: [0, 0.52, 0] },
          { g: G.cyl(0.5, 0.52, 0.08, 10), c: trim, p: [0, 0.05, 0] },
        ])
        add(this.body, [
          { g: G.cyl(0.26, 0.34, 0.72, 8), c: k === 'frost' ? 0xbfe8ff : c1, p: [0, 1.32, 0] },
          { g: G.box(0.62, 0.08, 0.4), c: trim, p: [0, 1.02, 0] },
          { g: G.sph(0.17, 6, 5), c: trim, p: [-0.34, 1.62, 0] },
          { g: G.sph(0.17, 6, 5), c: trim, p: [0.34, 1.62, 0] },
        ])
        if (k === 'mage') {
          add(this.head, [
            { g: G.sph(0.25, 10, 8), c: SKIN },
            { g: G.back(0.29), c: 0x4a2a7a, p: [0, 0.04, 0.0] },
            { g: G.cap(0.28), c: 0x4a2a7a, p: [0, 0.06, -0.01] },
            { g: G.box(0.34, 0.5, 0.12), c: 0x4a2a7a, p: [0, -0.2, -0.2] },
            { g: G.oct(0.09), c: GOLD, p: [0, 0.3, 0.12] },
            { g: G.box(0.06, 0.05, 0.02), c: DARK, p: [-0.09, 0.0, 0.24] },
            { g: G.box(0.06, 0.05, 0.02), c: DARK, p: [0.09, 0.0, 0.24] },
          ])
          add(this.armL, arm(c1))
          add(this.armR, [...arm(c1), { g: G.cyl(0.04, 0.05, 1.8, 6), c: 0xe8d8b0, p: [0, -0.62, 0.2], r: [Math.PI / 2 - 0.2, 0, 0] }])
          const star = new THREE.Mesh(G.oct(0.2), glow(0xe6c8ff, 1, false, true))
          star.position.set(0, -0.44, 1.08)
          this.armR.add(star)
          this.float.push(star)
        } else if (k === 'frost') {
          add(this.head, [
            { g: G.sph(0.25, 10, 8), c: SKIN },
            { g: G.back(0.29), c: 0xf4fbff, p: [0, 0.04, 0.0] },
            { g: G.cap(0.28), c: 0xf4fbff, p: [0, 0.06, -0.01] },
            { g: G.box(0.4, 0.62, 0.14), c: 0xf4fbff, p: [0, -0.26, -0.18] },
            { g: G.oct(0.1), c: 0x8fe3ff, p: [0.16, 0.24, 0.1] },
            { g: G.box(0.06, 0.05, 0.02), c: 0x3a6a9a, p: [-0.09, 0.0, 0.24] },
            { g: G.box(0.06, 0.05, 0.02), c: 0x3a6a9a, p: [0.09, 0.0, 0.24] },
          ])
          add(this.armL, arm(0xbfe8ff))
          add(this.armR, [...arm(0xbfe8ff), { g: G.cyl(0.04, 0.05, 1.8, 6), c: 0xffffff, p: [0, -0.62, 0.2], r: [Math.PI / 2 - 0.2, 0, 0] }])
          const cr = new THREE.Mesh(G.oct(0.24), glow(0x9fefff, 0.95, false, true))
          cr.scale.set(0.8, 1.4, 0.8)
          cr.position.set(0, -0.44, 1.08)
          this.armR.add(cr)
          this.float.push(cr)
          for (let i = 0; i < 3; i++) {
            const s = new THREE.Mesh(G.oct(0.1), glow(0xbff4ff, 0.9, false, true))
            s.userData.orbit = i * 2.09
            this.body.add(s)
            this.float.push(s)
          }
        } else {
          add(this.head, [
            { g: G.sph(0.25, 10, 8), c: SKIN },
            { g: G.back(0.3), c: 0x5a140c, p: [0, 0.04, 0.0] },
            { g: G.cap(0.29), c: 0x5a140c, p: [0, 0.07, -0.01] },
            { g: G.cone(0.07, 0.35, 5), c: 0x2a0a06, p: [-0.2, 0.3, -0.02], r: [-0.3, 0, 0.5] },
            { g: G.cone(0.07, 0.35, 5), c: 0x2a0a06, p: [0.2, 0.3, -0.02], r: [-0.3, 0, -0.5] },
            { g: G.box(0.07, 0.05, 0.02), c: 0xffa040, p: [-0.09, 0.0, 0.24] },
            { g: G.box(0.07, 0.05, 0.02), c: 0xffa040, p: [0.09, 0.0, 0.24] },
          ])
          add(this.armL, arm(c1))
          add(this.armR, arm(c1))
          const orb = new THREE.Mesh(G.sph(0.2, 10, 8), glow(0xff8a2a, 1, false, true))
          const halo = new THREE.Mesh(G.sph(0.34, 10, 8), glow(0xff5a1a, 0.4, true))
          orb.add(halo)
          orb.position.set(0, -0.95, 0.15)
          this.armL.add(orb)
          this.float.push(orb)
        }
        break
      }
      case 'golem': {
        this.scale = 1.2
        const rock = c1, rock2 = c2, moss = 0x5a7a3a
        add(this.legL, [{ g: G.cyl(0.2, 0.24, 0.9, 6), c: rock2, p: [0, -0.45, 0] }, { g: G.dod(0.22), c: rock, p: [0, -0.85, 0.05] }])
        add(this.legR, [{ g: G.cyl(0.2, 0.24, 0.9, 6), c: rock2, p: [0, -0.45, 0] }, { g: G.dod(0.22), c: rock, p: [0, -0.85, 0.05] }])
        add(this.body, [
          { g: G.dod(0.55), c: rock, p: [0, 1.35, 0], s: [1.2, 1, 0.9] },
          { g: G.dod(0.3), c: rock2, p: [-0.3, 1.0, 0.1] },
          { g: G.dod(0.28), c: moss, p: [0.1, 1.8, -0.25] },
          { g: G.dod(0.35), c: rock2, p: [-0.45, 1.7, 0] },
          { g: G.dod(0.35), c: rock2, p: [0.45, 1.7, 0] },
        ])
        add(this.head, [
          { g: G.dod(0.26), c: rock, p: [0, -0.05, 0.05] },
          { g: G.box(0.08, 0.05, 0.04), c: 0xffd24a, p: [-0.1, 0, 0.27] },
          { g: G.box(0.08, 0.05, 0.04), c: 0xffd24a, p: [0.1, 0, 0.27] },
        ])
        this.head.position.y = 1.92
        this.armL.position.x = -0.62
        this.armR.position.x = 0.62
        add(this.armL, [{ g: G.cyl(0.14, 0.18, 0.6, 6), c: rock2, p: [0, -0.3, 0] }, { g: G.dod(0.3), c: rock, p: [0, -0.72, 0.05] }])
        add(this.armR, [{ g: G.cyl(0.14, 0.18, 0.6, 6), c: rock2, p: [0, -0.3, 0] }, { g: G.dod(0.3), c: rock, p: [0, -0.72, 0.05] }])
        break
      }
      case 'assassin': {
        this.twin = true
        add(this.body, [
          { g: G.box(0.56, 0.7, 0.34), c: c2, p: [0, 1.3, 0] },
          { g: G.box(0.6, 0.08, 0.38), c: c1, p: [0, 0.99, 0] },
          { g: G.box(0.08, 0.6, 0.04), c: c1, p: [0, 1.32, 0.18], r: [0, 0, 0.6] },
        ])
        add(this.head, [
          { g: G.sph(0.25, 10, 8), c: 0x1a1024 },
          { g: G.box(0.3, 0.12, 0.08), c: 0x3a2a4a, p: [0, -0.06, 0.2] },
          { g: G.box(0.08, 0.04, 0.02), c: 0xc9a0ff, p: [-0.09, 0.04, 0.25] },
          { g: G.box(0.08, 0.04, 0.02), c: 0xc9a0ff, p: [0.09, 0.04, 0.25] },
          { g: G.cone(0.08, 0.3, 4), c: 0x1a1024, p: [0, 0.3, -0.1], r: [-0.8, 0, 0] },
        ])
        const dag = (side: number): PartSpec[] => [
          ...arm(c2, 0x1a1024),
          { g: G.box(0.05, 0.04, 0.6), c: 0xc8b8ff, p: [0, -0.64, 0.34] },
          { g: G.box(0.2, 0.05, 0.06), c: c1, p: [0, -0.64, 0.04] },
        ]
        add(this.armL, dag(-1))
        add(this.armR, dag(1))
        this.cape = add(this.body, [{ g: G.box(0.16, 1.1, 0.03), c: c1, p: [0, -0.55, 0] }])
        this.cape.position.set(0.12, 1.75, -0.2)
        break
      }
      case 'lancer': {
        this.spear = true
        add(this.body, [
          { g: G.box(0.64, 0.74, 0.4), c: c1, p: [0, 1.3, 0] },
          { g: G.box(0.3, 0.5, 0.06), c: c2, p: [0, 1.3, 0.21] },
          { g: G.box(0.7, 0.12, 0.44), c: c2, p: [0, 0.98, 0] },
          { g: G.sph(0.22, 6, 5), c: c1, p: [-0.4, 1.66, 0], s: [1.2, 0.8, 1.1] },
          { g: G.sph(0.22, 6, 5), c: c1, p: [0.4, 1.66, 0], s: [1.2, 0.8, 1.1] },
        ])
        add(this.head, [
          { g: G.sph(0.25, 10, 8), c: SKIN },
          { g: G.cap(0.3), c: c1, p: [0, 0.06, 0] },
          { g: G.cone(0.08, 0.55, 5), c: 0xd83a2a, p: [0, 0.38, -0.12], r: [-0.5, 0, 0] },
          { g: G.box(0.3, 0.04, 0.05), c: c2, p: [0, 0.02, 0.26] },
        ])
        add(this.armL, arm(c1))
        add(this.armR, [
          ...arm(c1),
          { g: G.cyl(0.045, 0.045, 2.6, 6), c: 0x3a2a1a, p: [0, -0.62, 0.55], r: [Math.PI / 2, 0, 0] },
          { g: G.cone(0.12, 0.45, 6), c: 0xfff08a, p: [0, -0.62, 2.05], r: [Math.PI / 2, 0, 0] },
          { g: G.tor(0.1, 0.03, 4, 8), c: GOLD, p: [0, -0.62, 1.8] },
        ])
        break
      }
    }
    this.root.scale.setScalar(this.scale)
    for (const m of this.meshes) m.castShadow = true
  }

  animate(s: AnimState) {
    const t = s.t
    const b = this.body
    // death
    if (s.dead >= 0) {
      const k = Math.min(1, s.dead / 0.45)
      b.rotation.x = -k * 1.45
      b.position.y = k * 0.25 - Math.max(0, s.dead - 2.5) * 0.4
      b.position.z = -k * 0.4
      this.legL.rotation.x = this.legR.rotation.x = 0
      this.armL.rotation.x = -k * 0.6
      this.armR.rotation.x = -k * 0.6
      return
    }
    b.rotation.x = 0
    b.position.z = 0
    const run = s.moving ? Math.min(1.4, s.speed / 4.5) : 0
    const freq = 7 + run * 3
    const sw = s.moving ? Math.sin(t * freq) : 0
    b.position.y = s.air + (s.moving ? Math.abs(Math.cos(t * freq)) * 0.07 : Math.sin(t * 2.2) * 0.02)
    b.rotation.x = s.moving ? 0.1 : 0
    this.legL.rotation.x = sw * 0.65 * run
    this.legR.rotation.x = -sw * 0.65 * run
    let aL = -sw * 0.5 * run, aR = sw * 0.5 * run
    let zL = 0.08, zR = -0.08
    if (this.bow) { aL = -1.45; zL = 0.15 }
    if (this.spear) { aR = -0.35 + sw * 0.15 }
    // attack
    if (s.atk < s.atkDur * 1.25) {
      const p = s.atk / s.atkDur
      if (this.bow) {
        aL = -1.55
        aR = p < 0.4 ? -1.4 - p * 0.4 : -1.4 + (p - 0.4) * 2
      } else if (this.spear) {
        const k = p < 0.35 ? p / 0.35 : Math.max(0, 1 - (p - 0.35) / 0.5)
        aR = -1.2 - k * 0.3
        b.position.z = k * 0.35
      } else if (this.twin) {
        const alt = Math.floor(s.t) % 2 === 0
        const k = p < 0.35 ? -2.2 * (p / 0.35) : -2.2 + (p - 0.35) * 5
        if (alt) aR = Math.min(0, k); else aL = Math.min(0, k)
      } else if (this.robe) {
        aR = -1.2 - Math.sin(Math.min(1, p) * Math.PI) * 0.6
      } else {
        // overhead swing
        aR = p < 0.4 ? -2.5 * (p / 0.4) : -2.5 + Math.min(1, (p - 0.4) / 0.25) * 2.3
        if (this.def.model === 'golem') aL = aR * 0.3
      }
    }
    // cast
    if (s.cast < 0.45) {
      const k = Math.sin((s.cast / 0.45) * Math.PI)
      aL = -1.6 * k + aL * (1 - k)
      aR = -1.6 * k + aR * (1 - k)
    }
    if (s.channel) { aL = -2.6; aR = -2.6; zL = 0.3; zR = -0.3 }
    if (s.stun) { aL *= 0.2; aR *= 0.2 }
    this.armL.rotation.x = aL
    this.armR.rotation.x = aR
    this.armL.rotation.z = zL
    this.armR.rotation.z = zR
    if (this.cape) this.cape.rotation.x = 0.15 + (s.moving ? 0.45 + sw * 0.1 : Math.sin(t * 1.7) * 0.05)
    if (this.robe) this.robe.rotation.z = sw * 0.04
    for (const f of this.float) {
      if (f.userData.orbit !== undefined) {
        const a = t * 1.8 + f.userData.orbit
        f.position.set(Math.cos(a) * 0.6, 1.6 + Math.sin(t * 2 + f.userData.orbit) * 0.12, Math.sin(a) * 0.6)
      }
      f.rotation.y = t * 2
    }
  }

  setOpacity(o: number) {
    this.root.traverse(obj => {
      const m = (obj as THREE.Mesh).material as THREE.Material | undefined
      if (!m) return
      if (o < 1) {
        if (!obj.userData.ownMat) {
          obj.userData.ownMat = true
          ;(obj as THREE.Mesh).material = (m as THREE.Material).clone()
        }
        const mm = (obj as THREE.Mesh).material as THREE.Material
        mm.transparent = true
        mm.opacity = o
      } else if (obj.userData.ownMat) {
        const mm = (obj as THREE.Mesh).material as THREE.Material
        mm.opacity = 1
        mm.transparent = false
      }
    })
  }
}

// -------------------------------------------------------------------------------- minions

const minionGeo = new Map<string, THREE.BufferGeometry>()
export function minionGeometry(type: MinionType, team: number): THREE.BufferGeometry {
  const key = type + team
  let g = minionGeo.get(key)
  if (g) return g
  const tc = team === 0 ? 0x4a7ddb : 0xd34a4a
  const td = team === 0 ? 0x223c78 : 0x782222
  let parts: PartSpec[]
  switch (type) {
    case 'melee':
      parts = [
        { g: G.box(0.18, 0.45, 0.2), c: DARK, p: [-0.12, 0.23, 0] },
        { g: G.box(0.18, 0.45, 0.2), c: DARK, p: [0.12, 0.23, 0] },
        { g: G.box(0.52, 0.5, 0.38), c: tc, p: [0, 0.7, 0] },
        { g: G.sph(0.22, 8, 6), c: td, p: [0, 1.12, 0] },
        { g: G.box(0.3, 0.06, 0.05), c: 0xffe08a, p: [0, 1.12, 0.2] },
        { g: G.box(0.06, 0.06, 0.8), c: STEEL, p: [0.34, 0.72, 0.4] },
        { g: G.cyl(0.26, 0.26, 0.06, 8), c: td, p: [-0.34, 0.72, 0.1], r: [0, 0, Math.PI / 2] },
      ]
      break
    case 'caster':
      parts = [
        { g: G.cone(0.38, 0.8, 8), c: tc, p: [0, 0.4, 0] },
        { g: G.cyl(0.2, 0.26, 0.4, 8), c: tc, p: [0, 0.88, 0] },
        { g: G.sph(0.2, 8, 6), c: SKIN, p: [0, 1.18, 0] },
        { g: G.cone(0.24, 0.42, 8), c: td, p: [0, 1.4, -0.02] },
        { g: G.cyl(0.03, 0.03, 1.1, 5), c: WOOD, p: [0.3, 0.8, 0.1] },
        { g: G.sph(0.1, 6, 5), c: team === 0 ? 0x9ad0ff : 0xffa0a0, p: [0.3, 1.38, 0.1] },
      ]
      break
    case 'siege':
      parts = [
        { g: G.box(0.9, 0.4, 1.2), c: WOOD, p: [0, 0.45, 0] },
        { g: G.cyl(0.24, 0.24, 0.12, 10), c: DARK, p: [-0.5, 0.26, 0.38], r: [0, 0, Math.PI / 2] },
        { g: G.cyl(0.24, 0.24, 0.12, 10), c: DARK, p: [0.5, 0.26, 0.38], r: [0, 0, Math.PI / 2] },
        { g: G.cyl(0.24, 0.24, 0.12, 10), c: DARK, p: [-0.5, 0.26, -0.38], r: [0, 0, Math.PI / 2] },
        { g: G.cyl(0.24, 0.24, 0.12, 10), c: DARK, p: [0.5, 0.26, -0.38], r: [0, 0, Math.PI / 2] },
        { g: G.cyl(0.16, 0.2, 0.9, 8), c: 0x4a4a52, p: [0, 0.85, 0.2], r: [Math.PI / 2 - 0.35, 0, 0] },
        { g: G.box(0.5, 0.3, 0.5), c: tc, p: [0, 0.8, -0.3] },
        { g: G.box(0.04, 0.8, 0.04), c: WOOD, p: [-0.35, 1.1, -0.5] },
        { g: G.box(0.3, 0.22, 0.02), c: tc, p: [-0.2, 1.35, -0.5] },
      ]
      break
    default:
      parts = [
        { g: G.box(0.3, 0.6, 0.32), c: DARK, p: [-0.2, 0.3, 0] },
        { g: G.box(0.3, 0.6, 0.32), c: DARK, p: [0.2, 0.3, 0] },
        { g: G.box(0.85, 0.8, 0.6), c: tc, p: [0, 1.0, 0] },
        { g: G.sph(0.28, 8, 6), c: td, p: [0, 1.6, 0.05] },
        { g: G.cone(0.12, 0.4, 5), c: 0xeeeeee, p: [-0.5, 1.5, 0], r: [0, 0, 0.5] },
        { g: G.cone(0.12, 0.4, 5), c: 0xeeeeee, p: [0.5, 1.5, 0], r: [0, 0, -0.5] },
        { g: G.dod(0.28), c: td, p: [-0.58, 0.85, 0.2] },
        { g: G.dod(0.28), c: td, p: [0.58, 0.85, 0.2] },
        { g: G.box(0.3, 0.06, 0.05), c: 0xffe08a, p: [0, 1.6, 0.3] },
      ]
  }
  g = mergeParts(parts)
  minionGeo.set(key, g)
  return g
}

// -------------------------------------------------------------------------------- monsters

const monsterGeo = new Map<string, THREE.BufferGeometry>()
export function monsterGeometry(type: MonsterType): THREE.BufferGeometry {
  let g = monsterGeo.get(type)
  if (g) return g
  let parts: PartSpec[] = []
  const legs4 = (c: number, w: number, l: number, h: number, t = 0.14): PartSpec[] => [
    { g: G.box(t, h, t), c, p: [-w, h / 2, l] }, { g: G.box(t, h, t), c, p: [w, h / 2, l] },
    { g: G.box(t, h, t), c, p: [-w, h / 2, -l] }, { g: G.box(t, h, t), c, p: [w, h / 2, -l] },
  ]
  switch (type) {
    case 'gromp':
      parts = [
        { g: G.sph(1.0, 12, 8), c: 0x6b7a3a, p: [0, 0.9, 0], s: [1.1, 0.75, 1.0] },
        { g: G.sph(0.8, 10, 6), c: 0xb5a86a, p: [0, 0.75, 0.3], s: [1, 0.7, 0.9] },
        { g: G.sph(0.22, 8, 6), c: 0xfff06a, p: [-0.42, 1.55, 0.55] },
        { g: G.sph(0.22, 8, 6), c: 0xfff06a, p: [0.42, 1.55, 0.55] },
        { g: G.sph(0.1, 6, 4), c: DARK, p: [-0.42, 1.58, 0.74] },
        { g: G.sph(0.1, 6, 4), c: DARK, p: [0.42, 1.58, 0.74] },
        { g: G.box(0.3, 0.4, 0.5), c: 0x5a6a2a, p: [-0.8, 0.2, 0.3] },
        { g: G.box(0.3, 0.4, 0.5), c: 0x5a6a2a, p: [0.8, 0.2, 0.3] },
      ]
      break
    case 'sentinel':
      parts = [
        { g: G.cyl(0.3, 0.35, 1.2, 6), c: 0x4a5670, p: [-0.4, 0.6, 0] },
        { g: G.cyl(0.3, 0.35, 1.2, 6), c: 0x4a5670, p: [0.4, 0.6, 0] },
        { g: G.dod(0.95), c: 0x5a6a8a, p: [0, 1.9, 0], s: [1.2, 1, 0.9] },
        { g: G.dod(0.4), c: 0x4a5670, p: [0, 2.9, 0.2] },
        { g: G.oct(0.35), c: 0x4ab8ff, p: [-0.4, 2.7, -0.5], s: [0.7, 1.6, 0.7] },
        { g: G.oct(0.4), c: 0x4ab8ff, p: [0.35, 2.8, -0.55], s: [0.7, 1.8, 0.7] },
        { g: G.oct(0.3), c: 0x6ad0ff, p: [0, 3.1, -0.4], s: [0.7, 1.6, 0.7] },
        { g: G.dod(0.45), c: 0x5a6a8a, p: [-1.15, 1.5, 0.3] },
        { g: G.dod(0.45), c: 0x5a6a8a, p: [1.15, 1.5, 0.3] },
        { g: G.box(0.12, 0.08, 0.05), c: 0x8ae0ff, p: [-0.14, 2.95, 0.58] },
        { g: G.box(0.12, 0.08, 0.05), c: 0x8ae0ff, p: [0.14, 2.95, 0.58] },
      ]
      break
    case 'brambleback':
      parts = [
        ...legs4(0x5a1a14, 0.6, 0.5, 0.7, 0.3),
        { g: G.sph(1.1, 12, 8), c: 0xb8372e, p: [0, 1.5, 0], s: [1.1, 0.9, 1.3] },
        { g: G.sph(0.55, 10, 8), c: 0x8a2a22, p: [0, 1.6, 1.3] },
        { g: G.cone(0.14, 0.6, 5), c: 0xf0e0c0, p: [-0.35, 2.0, 1.4], r: [0.5, 0, 0.4] },
        { g: G.cone(0.14, 0.6, 5), c: 0xf0e0c0, p: [0.35, 2.0, 1.4], r: [0.5, 0, -0.4] },
        ...[-0.6, 0, 0.6].map(x => ({ g: G.cone(0.18, 0.7, 5), c: 0x3a1a10, p: [x, 2.45, -0.2] as V3, r: [-0.3, 0, 0] as V3 })),
        ...[-0.4, 0.4].map(x => ({ g: G.cone(0.16, 0.6, 5), c: 0x3a1a10, p: [x, 2.3, -0.8] as V3, r: [-0.6, 0, 0] as V3 })),
        { g: G.box(0.1, 0.08, 0.05), c: 0xffe06a, p: [-0.2, 1.75, 1.8] },
        { g: G.box(0.1, 0.08, 0.05), c: 0xffe06a, p: [0.2, 1.75, 1.8] },
      ]
      break
    case 'wolf': case 'wolfling': {
      const c = type === 'wolf' ? 0x4a4a58 : 0x5a5a66
      parts = [
        ...legs4(0x2a2a33, 0.25, 0.45, 0.55),
        { g: G.box(0.6, 0.5, 1.3), c, p: [0, 0.8, 0] },
        { g: G.box(0.45, 0.42, 0.45), c, p: [0, 1.05, 0.75] },
        { g: G.cone(0.16, 0.5, 5), c, p: [0, 0.96, 1.12], r: [Math.PI / 2, 0, 0] },
        { g: G.cone(0.08, 0.2, 4), c, p: [-0.14, 1.34, 0.72] },
        { g: G.cone(0.08, 0.2, 4), c, p: [0.14, 1.34, 0.72] },
        { g: G.cone(0.1, 0.6, 5), c, p: [0, 0.95, -0.85], r: [-1.1, 0, 0] },
        { g: G.box(0.07, 0.05, 0.04), c: 0x6ad0ff, p: [-0.12, 1.12, 0.98] },
        { g: G.box(0.07, 0.05, 0.04), c: 0x6ad0ff, p: [0.12, 1.12, 0.98] },
      ]
      if (type === 'wolfling') parts = parts.map(p => ({ ...p, p: p.p ? [p.p[0] * 0.65, p.p[1] * 0.65, p.p[2] * 0.65] as V3 : undefined, s: [0.65, 0.65, 0.65] as V3 }))
      break
    }
    case 'raptor': case 'raptorling': {
      parts = [
        { g: G.box(0.1, 0.7, 0.1), c: 0xe0a040, p: [-0.2, 0.35, 0] },
        { g: G.box(0.1, 0.7, 0.1), c: 0xe0a040, p: [0.2, 0.35, 0] },
        { g: G.sph(0.55, 10, 8), c: 0xd8643a, p: [0, 1.0, 0], s: [0.9, 0.9, 1.2] },
        { g: G.cyl(0.14, 0.2, 0.6, 6), c: 0xd8643a, p: [0, 1.45, 0.45], r: [0.5, 0, 0] },
        { g: G.sph(0.24, 8, 6), c: 0xe8743a, p: [0, 1.75, 0.6] },
        { g: G.cone(0.1, 0.35, 5), c: 0xf0c040, p: [0, 1.72, 0.9], r: [Math.PI / 2, 0, 0] },
        { g: G.cone(0.2, 0.7, 5), c: 0x9a3a1a, p: [0, 1.1, -0.75], r: [-1.2, 0, 0] },
        { g: G.cone(0.1, 0.35, 4), c: 0x9a3a1a, p: [0, 2.0, 0.5], r: [-0.4, 0, 0] },
      ]
      if (type === 'raptorling') parts = parts.map(p => ({ ...p, p: p.p ? [p.p[0] * 0.6, p.p[1] * 0.6, p.p[2] * 0.6] as V3 : undefined, s: [0.6, 0.6, 0.6] as V3 }))
      break
    }
    case 'krug': case 'krugling': {
      parts = [
        ...legs4(0x3a3028, 0.5, 0.4, 0.5, 0.18),
        { g: G.dod(0.85), c: 0x7a6a58, p: [0, 1.1, 0], s: [1.2, 0.9, 1.2] },
        { g: G.dod(0.4), c: 0x6a5a48, p: [0, 1.2, 0.9] },
        { g: G.box(0.4, 0.06, 0.06), c: 0xff8a2a, p: [0, 1.5, 0.3], r: [0, 0.4, 0] },
        { g: G.box(0.3, 0.06, 0.06), c: 0xff8a2a, p: [0.3, 1.2, -0.2], r: [0, -0.6, 0.3] },
        { g: G.box(0.1, 0.08, 0.05), c: 0xffb04a, p: [-0.15, 1.3, 1.25] },
        { g: G.box(0.1, 0.08, 0.05), c: 0xffb04a, p: [0.15, 1.3, 1.25] },
      ]
      if (type === 'krugling') parts = parts.map(p => ({ ...p, p: p.p ? [p.p[0] * 0.6, p.p[1] * 0.6, p.p[2] * 0.6] as V3 : undefined, s: [0.6, 0.6, 0.6] as V3 }))
      break
    }
    case 'dragon':
      parts = [
        ...legs4(0x8a2a1a, 0.9, 0.9, 1.2, 0.4),
        { g: G.sph(1.3, 12, 8), c: 0xd8552a, p: [0, 2.0, 0], s: [1.1, 0.95, 1.8] },
        { g: G.sph(0.8, 10, 8), c: 0xf0a060, p: [0, 1.6, 0.3], s: [0.9, 0.6, 1.5] },
        { g: G.cyl(0.35, 0.5, 1.6, 8), c: 0xd8552a, p: [0, 3.0, 2.0], r: [0.7, 0, 0] },
        { g: G.box(0.8, 0.6, 1.1), c: 0xd8552a, p: [0, 3.7, 2.8] },
        { g: G.box(0.6, 0.2, 0.6), c: 0xc8451a, p: [0, 3.45, 3.3] },
        { g: G.cone(0.12, 0.6, 5), c: 0xf0e0c0, p: [-0.3, 4.2, 2.5], r: [-0.8, 0, 0] },
        { g: G.cone(0.12, 0.6, 5), c: 0xf0e0c0, p: [0.3, 4.2, 2.5], r: [-0.8, 0, 0] },
        { g: G.box(0.12, 0.1, 0.06), c: 0xffe04a, p: [-0.25, 3.85, 3.36] },
        { g: G.box(0.12, 0.1, 0.06), c: 0xffe04a, p: [0.25, 3.85, 3.36] },
        { g: G.box(2.6, 0.08, 1.6), c: 0x8a2a1a, p: [-1.6, 3.0, -0.2], r: [0, 0, 0.45] },
        { g: G.box(2.6, 0.08, 1.6), c: 0x8a2a1a, p: [1.6, 3.0, -0.2], r: [0, 0, -0.45] },
        { g: G.cone(0.5, 2.6, 6), c: 0xd8552a, p: [0, 1.8, -2.8], r: [-1.3, 0, 0] },
      ]
      break
    case 'baron':
      parts = [
        { g: G.cyl(2.2, 2.6, 0.5, 12), c: 0x3a2a4a, p: [0, 0.25, 0] },
        { g: G.sph(1.5, 12, 8), c: 0x6a3a9a, p: [0, 1.6, -0.4] },
        { g: G.sph(1.3, 12, 8), c: 0x7a4aaa, p: [0, 3.0, 0.1] },
        { g: G.sph(1.1, 12, 8), c: 0x6a3a9a, p: [0, 4.3, 0.7] },
        { g: G.sph(1.0, 12, 8), c: 0x8a5aba, p: [0, 5.4, 1.4], s: [1, 0.85, 1.25] },
        { g: G.box(0.2, 0.14, 0.08), c: 0xff6ad8, p: [-0.4, 5.6, 2.55] },
        { g: G.box(0.2, 0.14, 0.08), c: 0xff6ad8, p: [0.4, 5.6, 2.55] },
        ...[-1, -0.5, 0, 0.5, 1].map(x => ({ g: G.cone(0.2, 1.0, 5), c: 0x2a1a3a, p: [x * 0.8, 6.2, 1.0] as V3, r: [-0.5, 0, -x * 0.5] as V3 })),
        ...[0, 1, 2, 3, 4, 5].map(i => ({ g: G.cone(0.3, 1.8, 5), c: 0x4a2a6a, p: [Math.cos(i) * 2.2, 0.8, Math.sin(i) * 2.2] as V3, r: [Math.sin(i) * 0.5, 0, -Math.cos(i) * 0.5] as V3 })),
      ]
      break
  }
  g = mergeParts(parts)
  monsterGeo.set(type, g)
  return g
}

// -------------------------------------------------------------------------------- structures

export class TowerModel {
  root = new THREE.Group()
  alive = new THREE.Group()
  rubble: THREE.Mesh
  crystal: THREE.Mesh
  constructor(team: number) {
    const tc = TEAM_COLORS[team], td = TEAM_DARK[team]
    const base = new THREE.Mesh(mergeParts([
      { g: G.cyl(1.6, 1.8, 0.9, 10), c: 0x7a7e88, p: [0, 0.45, 0] },
      { g: G.cyl(1.0, 1.25, 4.4, 8), c: 0x9aa0aa, p: [0, 3.1, 0] },
      { g: G.cyl(1.28, 1.28, 0.3, 8), c: td, p: [0, 2.0, 0] },
      { g: G.cyl(1.45, 1.1, 0.6, 8), c: 0x6a6e78, p: [0, 5.5, 0] },
      ...[0, 1, 2, 3].map(i => ({ g: G.box(0.3, 0.7, 0.3), c: 0x8a8e98, p: [Math.cos(i * Math.PI / 2 + 0.78) * 1.2, 6.1, Math.sin(i * Math.PI / 2 + 0.78) * 1.2] as V3 })),
      { g: G.cyl(0.25, 0.4, 0.6, 6), c: td, p: [0, 6.0, 0] },
    ]), vcMatFow)
    base.castShadow = true
    base.receiveShadow = true
    this.alive.add(base)
    this.crystal = new THREE.Mesh(G.oct(0.6), glow(tc, 1, false, true))
    this.crystal.scale.set(0.8, 1.4, 0.8)
    this.crystal.position.y = 6.9
    const halo = new THREE.Mesh(G.sph(0.9, 10, 8), glow(tc, 0.25, true))
    this.crystal.add(halo)
    this.alive.add(this.crystal)
    this.root.add(this.alive)
    this.rubble = new THREE.Mesh(mergeParts([
      { g: G.cyl(1.6, 1.8, 0.9, 10), c: 0x6a6e78, p: [0, 0.45, 0] },
      { g: G.dod(0.6), c: 0x8a8e98, p: [0.8, 1.0, 0.3] },
      { g: G.dod(0.5), c: 0x7a7e88, p: [-0.7, 0.9, -0.4] },
      { g: G.dod(0.45), c: 0x9aa0aa, p: [0.1, 1.2, -0.8] },
      { g: G.cyl(1.0, 1.1, 1.2, 8), c: 0x8a8e98, p: [0, 1.3, 0], r: [0.2, 0, 0.3] },
    ]), vcMatFow)
    this.rubble.visible = false
    this.rubble.castShadow = true
    this.root.add(this.rubble)
  }
  update(t: number, dead: boolean) {
    this.alive.visible = !dead
    this.rubble.visible = dead
    this.crystal.rotation.y = t * 0.8
    this.crystal.position.y = 6.9 + Math.sin(t * 1.5) * 0.15
  }
}

export class InhibModel {
  root = new THREE.Group()
  crystal: THREE.Mesh
  ring: THREE.Mesh
  deadRing: THREE.Mesh
  constructor(team: number) {
    const tc = TEAM_COLORS[team]
    const base = new THREE.Mesh(mergeParts([
      { g: G.cyl(1.8, 2.0, 0.5, 12), c: 0x7a7e88, p: [0, 0.25, 0] },
      { g: G.cyl(1.2, 1.4, 0.3, 12), c: 0x5a5e68, p: [0, 0.6, 0] },
    ]), vcMatFow)
    base.receiveShadow = true
    this.root.add(base)
    this.ring = new THREE.Mesh(G.tor(1.3, 0.1, 6, 24), glow(tc, 0.9, false, true))
    this.ring.rotation.x = Math.PI / 2
    this.ring.position.y = 1.4
    this.root.add(this.ring)
    this.deadRing = new THREE.Mesh(G.tor(1.3, 0.1, 6, 24), lambert(0x444444, { fow: true }))
    this.deadRing.rotation.x = Math.PI / 2
    this.deadRing.position.y = 0.8
    this.root.add(this.deadRing)
    this.crystal = new THREE.Mesh(G.ico(0.75, 0), glow(tc, 1, false, true))
    this.crystal.position.y = 2.0
    const halo = new THREE.Mesh(G.sph(1.1, 12, 8), glow(tc, 0.2, true))
    this.crystal.add(halo)
    this.root.add(this.crystal)
  }
  update(t: number, dead: boolean) {
    this.crystal.visible = !dead
    this.ring.visible = !dead
    this.deadRing.visible = dead
    this.crystal.rotation.set(t * 0.6, t * 0.9, 0)
    this.crystal.position.y = 2.0 + Math.sin(t * 1.3) * 0.2
    this.ring.rotation.z = t * 0.5
  }
}

export class NexusModel {
  root = new THREE.Group()
  crystal = new THREE.Group()
  rubble: THREE.Mesh
  constructor(team: number) {
    const tc = TEAM_COLORS[team], td = TEAM_DARK[team]
    const base = new THREE.Mesh(mergeParts([
      { g: G.cyl(3.6, 4.0, 0.9, 16), c: 0x7a7e88, p: [0, 0.45, 0] },
      { g: G.cyl(2.7, 3.1, 0.7, 16), c: 0x8a8e98, p: [0, 1.25, 0] },
      { g: G.cyl(2.75, 2.75, 0.12, 16), c: td, p: [0, 1.62, 0] },
      ...[0, 1, 2, 3, 4, 5].map(i => ({ g: G.box(0.5, 1.8, 0.5), c: 0x6a6e78, p: [Math.cos(i * 1.047) * 3.1, 1.3, Math.sin(i * 1.047) * 3.1] as V3 })),
    ]), vcMatFow)
    base.castShadow = true
    base.receiveShadow = true
    this.root.add(base)
    const main = new THREE.Mesh(G.oct(1.2), glow(tc, 1, false, true))
    main.scale.set(1, 2.1, 1)
    main.position.y = 4.3
    this.crystal.add(main)
    for (let i = 0; i < 4; i++) {
      const c = new THREE.Mesh(G.oct(0.5), glow(tc, 0.95, false, true))
      c.scale.set(0.7, 1.6, 0.7)
      c.position.set(Math.cos(i * 1.57) * 1.9, 3.2, Math.sin(i * 1.57) * 1.9)
      this.crystal.add(c)
    }
    const halo = new THREE.Mesh(G.sph(2.4, 14, 10), glow(tc, 0.14, true))
    halo.position.y = 4.1
    this.crystal.add(halo)
    this.root.add(this.crystal)
    this.rubble = new THREE.Mesh(mergeParts([
      { g: G.dod(1.2), c: 0x5a5e68, p: [0.8, 2.0, 0.4] },
      { g: G.dod(0.9), c: 0x6a6e78, p: [-1.0, 1.9, -0.6] },
      { g: G.dod(0.7), c: td, p: [0.2, 2.2, -1.2] },
    ]), vcMatFow)
    this.rubble.visible = false
    this.root.add(this.rubble)
  }
  update(t: number, dead: boolean) {
    this.crystal.visible = !dead
    this.rubble.visible = dead
    this.crystal.rotation.y = t * 0.35
    this.crystal.position.y = Math.sin(t * 0.9) * 0.2
  }
}

export function wardMesh(team: number) {
  const g = new THREE.Group()
  const b = new THREE.Mesh(mergeParts([
    { g: G.cyl(0.1, 0.16, 0.9, 6), c: 0x5a4a3a, p: [0, 0.45, 0] },
    { g: G.cyl(0.25, 0.25, 0.06, 8), c: 0x5a4a3a, p: [0, 0.03, 0] },
  ]))
  g.add(b)
  const eye = new THREE.Mesh(G.sph(0.2, 8, 6), glow(team === 0 ? 0x7ad0ff : 0xff7a6a, 1, false, true))
  eye.position.y = 1.05
  g.add(eye)
  return g
}

export function fountainMesh(team: number) {
  const tc = TEAM_COLORS[team]
  const g = new THREE.Group()
  const base = new THREE.Mesh(mergeParts([
    { g: G.cyl(6, 6.3, 0.35, 24), c: 0x8a8e98, p: [0, 0.17, 0] },
    { g: G.cyl(2.2, 2.5, 0.6, 16), c: 0x6a6e78, p: [0, 0.5, 0] },
    ...[0, 1, 2, 3, 4, 5, 6, 7].map(i => ({ g: G.box(0.5, 2.4, 0.5), c: 0x7a7e88, p: [Math.cos(i * 0.785) * 5.4, 1.2, Math.sin(i * 0.785) * 5.4] as V3 })),
  ]), vcMatFow)
  base.receiveShadow = true
  g.add(base)
  const ring = new THREE.Mesh(G.tor(5.9, 0.12, 6, 48), glow(tc, 0.8, false, true))
  ring.rotation.x = Math.PI / 2
  ring.position.y = 0.4
  g.add(ring)
  const pool = new THREE.Mesh(G.cyl(2.1, 2.1, 0.1, 20), glow(tc, 0.55, true))
  pool.position.y = 0.82
  g.add(pool)
  const cr = new THREE.Mesh(G.oct(0.7), glow(tc, 1, false, true))
  cr.scale.set(0.8, 1.6, 0.8)
  cr.position.y = 2.8
  cr.name = 'crystal'
  g.add(cr)
  return g
}
