import * as THREE from 'three'
import type { World } from '../game/world'
import { Unit } from '../game/unit'
import { Champion } from '../game/champion'
import { Minion, Monster, Ward } from '../game/npc'
import { F } from '../game/types'
import { buildTerrain } from './terrain'
import { ChampModel, TowerModel, InhibModel, NexusModel, minionGeometry, monsterGeometry, wardMesh, fountainMesh, AnimState } from './models'
import { FxLayer } from './effects'
import { FogTexture } from './fog'
import { Overlay } from './overlay'
import { fowUniforms, glow, vcMat, fadeMat } from './mats'
import { clamp, lerp } from '../util/math'

export interface IndicatorSpec {
  kind: 'line' | 'circle' | 'cone' | 'range' | 'none'
  range: number
  width?: number
  radius?: number
  angle?: number
  tx: number
  tz: number
  color?: number
}

interface UnitView {
  u: Unit
  root: THREE.Group
  champ?: ChampModel
  mesh?: THREE.Mesh
  tower?: TowerModel
  inhib?: InhibModel
  nexus?: NexusModel
  ring?: THREE.Mesh
  stars?: THREE.Group
  recall?: THREE.Group
  wasStealth?: boolean
  lastAtk: number
  deadSeen: number
}

const CAM_OFFSET = new THREE.Vector3(0, 27, 17.5)

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly overlay: Overlay
  readonly fx: FxLayer
  readonly fog: FogTexture
  private sun: THREE.DirectionalLight
  private views = new Map<Unit, UnitView>()
  private staticRoot = new THREE.Group()
  camTarget = new THREE.Vector3()
  zoom = 1
  private zoomTarget = 1
  locked = true
  hovered: Unit | null = null
  private hoverRing: THREE.Mesh
  private rangeRing: THREE.Mesh
  private indLine: THREE.Mesh
  private indCircle: THREE.Group
  private indCone: THREE.Mesh
  private indConeAngle = -1
  private raycaster = new THREE.Raycaster()
  private tmpV = new THREE.Vector3()
  private w = 1
  private h = 1
  private fountainCrystals: THREE.Object3D[] = []
  shadows = true
  quality = 1
  /** touch-mode rendering profile (lower pixel-ratio caps) */
  mobile = false
  /** camera offset ahead of the champion (touch aiming), world units */
  lead = { x: 0, z: 0 }

  constructor(private container: HTMLElement, private world: World, opts: { shadows?: boolean; quality?: number; mobile?: boolean } = {}) {
    this.shadows = opts.shadows ?? true
    this.quality = opts.quality ?? 1
    this.renderer = new THREE.WebGLRenderer({ antialias: this.quality >= 1, powerPreference: 'high-performance' })
    this.mobile = !!opts.mobile
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.dprCap()))
    this.renderer.shadowMap.enabled = this.shadows
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.domElement.className = 'game-canvas'
    container.appendChild(this.renderer.domElement)
    this.overlay = new Overlay(container)
    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 400)
    this.scene.background = new THREE.Color(0x0b1220)
    this.scene.fog = new THREE.Fog(0x0b1220, 90, 190)

    const hemi = new THREE.HemisphereLight(0xc4d8ff, 0x3a3424, 1.05)
    this.scene.add(hemi)
    this.sun = new THREE.DirectionalLight(0xfff0d8, 1.75)
    this.sun.castShadow = this.shadows
    this.sun.shadow.mapSize.set(2048, 2048)
    const sc = this.sun.shadow.camera
    sc.left = -38; sc.right = 38; sc.top = 38; sc.bottom = -38; sc.near = 1; sc.far = 140
    this.sun.shadow.bias = -0.0008
    this.sun.shadow.normalBias = 0.03
    this.scene.add(this.sun, this.sun.target)

    this.fog = new FogTexture(world.map.size)
    this.staticRoot.add(buildTerrain(world.grid, world.seed))
    for (const f of world.map.fountains) {
      const m = fountainMesh(f.team)
      m.position.set(f.x, world.grid.heightAt(f.x, f.z), f.z)
      this.staticRoot.add(m)
      this.fountainCrystals.push(m.getObjectByName('crystal')!)
    }
    // relics
    this.scene.add(this.staticRoot)
    this.fx = new FxLayer((x, z) => world.grid.heightAt(x, z), (x, z) => this.visibleAt(x, z))
    this.scene.add(this.fx.group)

    // indicators
    this.hoverRing = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 40), fadeMat(0xff4040, 0.9, false))
    this.hoverRing.rotation.x = -Math.PI / 2
    this.hoverRing.visible = false
    this.scene.add(this.hoverRing)
    this.rangeRing = new THREE.Mesh(new THREE.RingGeometry(0.985, 1, 120), fadeMat(0x9ad0ff, 0.55, false))
    this.rangeRing.rotation.x = -Math.PI / 2
    this.rangeRing.visible = false
    this.scene.add(this.rangeRing)
    const lineGeo = new THREE.PlaneGeometry(1, 1)
    lineGeo.translate(0, 0.5, 0)
    this.indLine = new THREE.Mesh(lineGeo, fadeMat(0x8ad0ff, 0.28, false, THREE.DoubleSide))
    this.indLine.visible = false
    this.scene.add(this.indLine)
    this.indCircle = new THREE.Group()
    const c1 = new THREE.Mesh(new THREE.CircleGeometry(1, 48), fadeMat(0x8ad0ff, 0.2, false))
    const c2 = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 64), fadeMat(0x8ad0ff, 0.8, false))
    c1.rotation.x = c2.rotation.x = -Math.PI / 2
    this.indCircle.add(c1, c2)
    this.indCircle.visible = false
    this.scene.add(this.indCircle)
    this.indCone = new THREE.Mesh(new THREE.CircleGeometry(1, 24, 0, 1), fadeMat(0x8ad0ff, 0.25, false, THREE.DoubleSide))
    this.indCone.visible = false
    this.scene.add(this.indCone)

    const me = world.me
    const f = world.map.fountains[world.myTeam as 0 | 1]
    this.camTarget.set(me ? me.x : f.x + 10, 0, me ? me.z : f.z - 10)
    this.resize()
  }

  resize() {
    const r = this.container.getBoundingClientRect()
    this.w = Math.max(1, r.width)
    this.h = Math.max(1, r.height)
    this.renderer.setSize(this.w, this.h, false)
    this.renderer.domElement.style.width = this.w + 'px'
    this.renderer.domElement.style.height = this.h + 'px'
    this.camera.aspect = this.w / this.h
    this.camera.updateProjectionMatrix()
    this.overlay.resize(this.w, this.h, Math.min(this.mobile ? this.dprCap() : 2, window.devicePixelRatio || 1))
  }

  get size() { return { w: this.w, h: this.h } }

  private dprCap() {
    return this.mobile ? (this.quality >= 1 ? 1.5 : 1) : (this.quality >= 1 ? 2 : 1)
  }

  setZoomTarget(v: number) {
    this.zoomTarget = clamp(v, 0.62, 1.45)
  }

  setZoom(delta: number) {
    this.zoomTarget = clamp(this.zoomTarget + delta, 0.62, 1.45)
  }

  visibleAt(x: number, z: number) {
    const w = this.world
    if (w.spectator) return true
    return w.vision.cellVisible(w.myTeam as 0 | 1, x, z)
  }

  // ------------------------------------------------------------------ camera & picking
  updateCamera(dt: number, follow: boolean) {
    const w = this.world
    if (follow && w.me) {
      const k = Math.min(1, dt * 10)
      this.camTarget.x = lerp(this.camTarget.x, w.me.x + this.lead.x, k)
      this.camTarget.z = lerp(this.camTarget.z, w.me.z + this.lead.z, k)
    }
    const S = w.map.size
    this.camTarget.x = clamp(this.camTarget.x, 14, S - 14)
    this.camTarget.z = clamp(this.camTarget.z, 16, S - 13)
    this.zoom = lerp(this.zoom, this.zoomTarget, Math.min(1, dt * 8))
    const gh = Math.max(0, w.grid.heightAt(this.camTarget.x, this.camTarget.z)) * 0.3
    this.camera.position.set(this.camTarget.x + CAM_OFFSET.x * this.zoom, gh + CAM_OFFSET.y * this.zoom, this.camTarget.z + CAM_OFFSET.z * this.zoom)
    this.camera.lookAt(this.camTarget.x, gh, this.camTarget.z)
    this.camera.updateMatrixWorld()
    this.sun.position.set(this.camTarget.x - 24, 48, this.camTarget.z + 14)
    this.sun.target.position.set(this.camTarget.x, 0, this.camTarget.z)
  }

  pan(dx: number, dz: number) {
    this.camTarget.x += dx
    this.camTarget.z += dz
  }
  centerOn(x: number, z: number) {
    this.camTarget.x = x
    this.camTarget.z = z
  }

  screenToGround(sx: number, sy: number): [number, number] {
    const ndc = new THREE.Vector2((sx / this.w) * 2 - 1, -(sy / this.h) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    const o = this.raycaster.ray.origin, d = this.raycaster.ray.direction
    let h = 0
    let x = o.x, z = o.z
    for (let i = 0; i < 3; i++) {
      const t = (h - o.y) / d.y
      x = o.x + d.x * t
      z = o.z + d.z * t
      const nh = this.world.grid.heightAt(x, z)
      h = Math.min(nh, 0.5)
    }
    return [x, z]
  }

  project(x: number, y: number, z: number, out: { x: number; y: number }) {
    const v = this.tmpV.set(x, y, z).project(this.camera)
    if (v.z > 1) return false
    out.x = (v.x * 0.5 + 0.5) * this.w
    out.y = (-v.y * 0.5 + 0.5) * this.h
    return true
  }

  pickUnit(sx: number, sy: number, accept: (u: Unit) => boolean, minRad = 12): Unit | null {
    const w = this.world
    let best: Unit | null = null, bd = Infinity
    const a = { x: 0, y: 0 }, b = { x: 0, y: 0 }, c = { x: 0, y: 0 }
    for (const u of w.units.values()) {
      if (u.dead || !accept(u) || !w.visibleToMe(u)) continue
      const gy = w.grid.heightAt(u.x, u.z) + u.airY
      if (!this.project(u.x, gy, u.z, a)) continue
      if (!this.project(u.x, gy + Math.min(u.height, 5), u.z, b)) continue
      this.project(u.x + u.radius + 0.35, gy, u.z, c)
      const rad = Math.max(minRad, Math.abs(c.x - a.x))
      // distance from mouse to vertical segment a-b
      const vx = b.x - a.x, vy = b.y - a.y
      const l2 = vx * vx + vy * vy || 1
      const t = clamp(((sx - a.x) * vx + (sy - a.y) * vy) / l2, 0, 1)
      const dx = sx - (a.x + vx * t), dy = sy - (a.y + vy * t)
      const d = Math.hypot(dx, dy)
      if (d > rad) continue
      const score = d - (u.isChamp ? 14 : 0)
      if (score < bd) { bd = score; best = u }
    }
    return best
  }

  cameraCorners(): [number, number][] {
    return [
      this.screenToGround(0, 0), this.screenToGround(this.w, 0),
      this.screenToGround(this.w, this.h), this.screenToGround(0, this.h),
    ]
  }

  // ------------------------------------------------------------------ indicators
  setIndicator(spec: IndicatorSpec | null, rangeOnly = 0) {
    const me = this.world.me
    this.indLine.visible = false
    this.indCircle.visible = false
    this.indCone.visible = false
    this.rangeRing.visible = false
    if (!me || me.dead) return
    const gy = this.world.grid.heightAt(me.x, me.z) + 0.07
    if (rangeOnly > 0 && !spec) {
      this.rangeRing.visible = true
      this.rangeRing.position.set(me.x, gy, me.z)
      this.rangeRing.scale.setScalar(rangeOnly)
      return
    }
    if (!spec || spec.kind === 'none') return
    const col = spec.color ?? 0x8ad0ff
    const setCol = (m: THREE.Mesh) => (m.material as THREE.MeshBasicMaterial).color.setHex(col)
    if (spec.range > 0 && spec.range < 40) {
      this.rangeRing.visible = true
      this.rangeRing.position.set(me.x, gy, me.z)
      this.rangeRing.scale.setScalar(spec.range)
    }
    const dx = spec.tx - me.x, dz = spec.tz - me.z
    const dir = Math.atan2(dx, dz)
    const d = Math.hypot(dx, dz)
    switch (spec.kind) {
      case 'line': {
        setCol(this.indLine)
        this.indLine.visible = true
        const len = Math.min(spec.range, 30)
        this.indLine.position.set(me.x, gy + 0.02, me.z)
        this.indLine.rotation.set(-Math.PI / 2, dir + Math.PI, 0, 'YXZ')
        this.indLine.scale.set(spec.width ?? 1, len, 1)
        break
      }
      case 'circle': {
        const r = Math.min(d, spec.range)
        const cx = d > 0.001 ? me.x + (dx / d) * r : me.x, cz = d > 0.001 ? me.z + (dz / d) * r : me.z
        this.indCircle.visible = true
        this.indCircle.children.forEach(c => setCol(c as THREE.Mesh))
        const selfCentered = spec.range <= (spec.radius ?? 0) + 0.01
        this.indCircle.position.set(selfCentered ? me.x : cx, this.world.grid.heightAt(cx, cz) + 0.08, selfCentered ? me.z : cz)
        this.indCircle.scale.setScalar(spec.radius ?? 2)
        break
      }
      case 'cone': {
        const a = spec.angle ?? 0.5
        if (this.indConeAngle !== a) {
          this.indCone.geometry.dispose()
          this.indCone.geometry = new THREE.CircleGeometry(1, 24, Math.PI / 2 - a, a * 2)
          this.indConeAngle = a
        }
        setCol(this.indCone)
        this.indCone.visible = true
        this.indCone.position.set(me.x, gy + 0.03, me.z)
        this.indCone.rotation.set(-Math.PI / 2, dir + Math.PI, 0, 'YXZ')
        this.indCone.scale.setScalar(spec.range)
        break
      }
      case 'range':
        break
    }
  }

  // ------------------------------------------------------------------ views
  private makeView(u: Unit): UnitView {
    const root = new THREE.Group()
    const v: UnitView = { u, root, lastAtk: -1, deadSeen: -1 }
    const w = this.world
    if (u instanceof Champion) {
      v.champ = new ChampModel(u.def)
      root.add(v.champ.root)
      const rel = u === w.me ? 0x5dff6a : w.spectator ? (u.team === 0 ? 0x3d8bff : 0xff4b4b) : u.team === w.myTeam ? 0x3d8bff : 0xff4b4b
      v.ring = new THREE.Mesh(new THREE.RingGeometry(0.78, 0.95, 40), fadeMat(rel, 0.75, false))
      v.ring.rotation.x = -Math.PI / 2
      v.ring.position.y = 0.06
      root.add(v.ring)
    } else if (u instanceof Minion) {
      v.mesh = new THREE.Mesh(minionGeometry(u.mt, u.team), vcMat)
      v.mesh.scale.setScalar(1.15)
      v.mesh.castShadow = true
      root.add(v.mesh)
    } else if (u instanceof Monster) {
      v.mesh = new THREE.Mesh(monsterGeometry(u.mt), vcMat)
      v.mesh.castShadow = true
      root.add(v.mesh)
    } else if (u instanceof Ward) {
      root.add(wardMesh(u.team))
    } else if (u.kind === 'tower') {
      v.tower = new TowerModel(u.team)
      root.add(v.tower.root)
    } else if (u.kind === 'inhib') {
      v.inhib = new InhibModel(u.team)
      root.add(v.inhib.root)
    } else if (u.kind === 'nexus') {
      v.nexus = new NexusModel(u.team)
      root.add(v.nexus.root)
    }
    this.scene.add(root)
    return v
  }

  private disposeView(v: UnitView) {
    this.scene.remove(v.root)
    v.root.traverse(o => {
      const m = o as THREE.Mesh
      if (m.geometry && (v.champ || m === v.ring)) {
        if (v.champ) m.geometry.dispose()
      }
      if (o.userData.ownMat) ((o as THREE.Mesh).material as THREE.Material).dispose()
    })
    if (v.ring) (v.ring.material as THREE.Material).dispose()
  }

  private starsGroup() {
    const g = new THREE.Group()
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 0), glow(0xffe24a, 1, false, true))
      s.position.set(Math.cos(i * 2.09) * 0.45, 0, Math.sin(i * 2.09) * 0.45)
      g.add(s)
    }
    return g
  }
  private recallGroup(team: number) {
    const g = new THREE.Group()
    const col = team === 0 ? 0x6ab8ff : 0xff8a7a
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 4.5, 20, 1, true), fadeMat(col, 0.22, true, THREE.DoubleSide))
    c.position.y = 2.25
    const r = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.1, 32), fadeMat(col, 0.9, true))
    r.rotation.x = -Math.PI / 2
    r.position.y = 0.08
    r.name = 'r'
    g.add(c, r)
    return g
  }

  private syncViews(dt: number, t: number) {
    const w = this.world
    for (const [u, v] of this.views) {
      if (!w.units.has(u.id) || w.units.get(u.id) !== u) {
        this.disposeView(v)
        this.views.delete(u)
      }
    }
    for (const u of w.units.values()) {
      let v = this.views.get(u)
      if (!v) { v = this.makeView(u); this.views.set(u, v) }
      this.updateView(v, dt, t)
    }
  }

  private updateView(v: UnitView, dt: number, t: number) {
    const u = v.u
    const w = this.world
    const vis = w.visibleToMe(u)
    const gy = w.grid.heightAt(u.x, u.z)
    if (u.isStructure) {
      v.root.position.set(u.x, gy, u.z)
      v.tower?.update(t, u.dead)
      v.inhib?.update(t, u.dead)
      v.nexus?.update(t, u.dead)
      return
    }
    if (u.dead && v.deadSeen < 0) v.deadSeen = w.now
    if (!u.dead) v.deadSeen = -1
    const deadT = v.deadSeen < 0 ? -1 : w.now - v.deadSeen
    const hideDead = u.kind !== 'champ' && deadT > 1.4
    v.root.visible = vis && !hideDead && !(u.isChamp && deadT > 4)
    if (!v.root.visible) return
    v.root.position.set(u.x, gy, u.z)
    if (v.champ) {
      const c = u as Champion
      v.champ.root.rotation.y = u.facing
      const atkDur = Math.max(0.25, 1 / Math.max(0.3, c.stats.as || 0.7)) * 0.75
      const st: AnimState = {
        t, moving: u.moving || !!(u.fl & F.MOVE), speed: u.local ? u.moveSpeed() : Math.max(3, u.speedNow),
        atk: w.now - u.animAtk, atkDur, cast: w.now - u.animCast, dead: deadT, stun: !!(u.fl & (F.STUN | F.KNOCKUP)),
        air: u.airY, channel: !!(u.fl & F.RECALL),
      }
      v.champ.animate(st)
      const stealth = !!(u.fl & F.STEALTH)
      if (stealth !== v.wasStealth) { v.champ.setOpacity(stealth ? 0.35 : 1); v.wasStealth = stealth }
      if (v.ring) v.ring.visible = !u.dead
      // stun stars
      const stunned = !!(u.fl & (F.STUN | F.KNOCKUP)) && !u.dead
      if (stunned && !v.stars) { v.stars = this.starsGroup(); v.root.add(v.stars) }
      if (v.stars) {
        v.stars.visible = stunned
        v.stars.position.y = 2.45 * v.champ.scale + u.airY
        v.stars.rotation.y = t * 5
      }
      const rec = !!(u.fl & F.RECALL) && !u.dead
      if (rec && !v.recall) { v.recall = this.recallGroup(u.team); v.root.add(v.recall) }
      if (v.recall) {
        v.recall.visible = rec
        const r = v.recall.getObjectByName('r')
        if (r) r.scale.setScalar(1 + Math.sin(t * 6) * 0.1)
      }
      if (u.fl & F.STASIS) v.champ.root.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.material === vcMat) { /* golden look via overlay effect */ } })
    } else if (v.mesh) {
      const m = v.mesh
      v.root.rotation.y = u.facing
      if (u.dead) {
        const k = Math.min(1, deadT / 0.5)
        m.rotation.x = -k * 1.2
        m.position.y = -Math.max(0, deadT - 0.5) * 1.2
      } else {
        m.rotation.x = 0
        const atk = w.now - u.animAtk
        const lunge = atk < 0.35 ? Math.sin((atk / 0.35) * Math.PI) * 0.35 : 0
        const bob = u.moving ? Math.abs(Math.sin(t * 9 + u.x)) * 0.08 : Math.sin(t * 2 + u.z) * 0.03
        m.position.set(0, bob + u.airY, lunge)
        if (u.kind === 'monster' && (u.fl & F.RESET)) m.position.y += 0.1
      }
    }
  }

  // ------------------------------------------------------------------ frame
  render(dt: number, t: number) {
    const w = this.world
    fowUniforms.fowOn.value = w.spectator ? 0 : 1
    this.fog.update(dt, w.spectator ? null : w.vision.vis[w.myTeam as 0 | 1])
    this.syncViews(dt, t)
    this.fx.update(w, dt, t)
    for (const c of this.fountainCrystals) { c.rotation.y = t * 0.7; c.position.y = 2.8 + Math.sin(t) * 0.2 }
    // hover ring
    const hv = this.hovered
    if (hv && !hv.dead && w.visibleToMe(hv)) {
      this.hoverRing.visible = true
      this.hoverRing.position.set(hv.x, w.grid.heightAt(hv.x, hv.z) + 0.09, hv.z)
      this.hoverRing.scale.setScalar(hv.radius + 0.35)
      ;(this.hoverRing.material as THREE.MeshBasicMaterial).color.setHex(hv.team === w.myTeam ? 0x5dff8a : hv.team === 2 ? 0xffc04a : 0xff4040)
    } else this.hoverRing.visible = false
    this.renderer.render(this.scene, this.camera)
    this.overlay.draw(w, (x, z) => w.grid.heightAt(x, z), (x, y, z, out) => this.project(x, y, z, out), this.hovered)
  }

  dispose() {
    for (const v of this.views.values()) this.disposeView(v)
    this.views.clear()
    this.fog.dispose()
    this.renderer.dispose()
    // free the GL context right away: browsers cap live contexts and a phone reuses this page for many matches
    try { this.renderer.forceContextLoss() } catch { /* ignore */ }
    this.renderer.domElement.remove()
    this.overlay.canvas.remove()
    this.scene.traverse(o => {
      const m = o as THREE.Mesh
      if (m.isMesh && m.geometry) m.geometry.dispose()
    })
  }
}
