import * as THREE from 'three'
import type { Grid } from '../game/grid'
import { patchFow, fowUniforms } from './mats'
import { fbm, hash2, mulberry32, vnoise } from '../util/math'

const C = (h: number) => new THREE.Color(h)
const GRASS = C(0x4a6a3a), GRASS2 = C(0x55773f), LANE = C(0x8c7a56), LANE2 = C(0x7a6a4a)
const PLAZA = [C(0x46526c), C(0x6c4848)]
const RIVERBED = C(0x3f5f5a), WALL_LO = C(0x3a5630), WALL_HI = C(0x2a4024), ROCK = C(0x5c5646), BRUSH = C(0x3f7a30)

export function buildTerrain(grid: Grid, seed = 1): THREE.Group {
  const S = grid.S, V = S + 1
  const group = new THREE.Group()
  const pos = new Float32Array(V * V * 3)
  const col = new Float32Array(V * V * 3)
  const tmp = new THREE.Color()
  const cellColor = (i: number, j: number, out: THREE.Color) => {
    i = Math.max(0, Math.min(S - 1, i)); j = Math.max(0, Math.min(S - 1, j))
    const k = j * S + i
    const n = fbm(i * 0.15, j * 0.15, 2)
    if (grid.walk[k]) {
      if (grid.river[k]) out.copy(RIVERBED)
      else if (grid.plaza[k]) out.copy(PLAZA[grid.plaza[k] - 1]).lerp(GRASS, 0.08 + n * 0.1)
      else if (grid.lane[k]) out.copy(LANE).lerp(LANE2, n)
      else out.copy(GRASS).lerp(GRASS2, n)
      if (grid.brush[k]) out.lerp(BRUSH, 0.5)
      // subtle checker noise
      const d = (hash2(i, j) - 0.5) * 0.05
      out.r += d; out.g += d; out.b += d
    } else {
      const wd = grid.wallDist[k]
      out.copy(WALL_LO).lerp(WALL_HI, Math.min(1, wd / 5))
      if (wd < 2.2) out.lerp(ROCK, (1 - wd / 2.2) * 0.55)
      out.lerp(GRASS2, n * 0.15)
    }
    return out
  }
  const acc = new THREE.Color()
  for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) {
    const v = j * V + i
    pos[v * 3] = i
    pos[v * 3 + 1] = grid.heights[v]
    pos[v * 3 + 2] = j
    acc.setRGB(0, 0, 0)
    for (const [di, dj] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      cellColor(i + di, j + dj, tmp)
      acc.r += tmp.r / 4; acc.g += tmp.g / 4; acc.b += tmp.b / 4
    }
    col[v * 3] = acc.r; col[v * 3 + 1] = acc.g; col[v * 3 + 2] = acc.b
  }
  const idx = new Uint32Array(S * S * 6)
  let p = 0
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const a = j * V + i, b = a + 1, c = a + V, d = c + 1
    idx[p++] = a; idx[p++] = c; idx[p++] = b
    idx[p++] = b; idx[p++] = c; idx[p++] = d
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  geo.computeVertexNormals()
  const mat = patchFow(new THREE.MeshLambertMaterial({ vertexColors: true }))
  const ground = new THREE.Mesh(geo, mat)
  ground.receiveShadow = true
  ground.name = 'ground'
  group.add(ground)

  // outer skirt so the map edge never shows the void
  const skirtMat = new THREE.MeshLambertMaterial({ color: 0x22361e })
  const B = 220
  for (const [cx, cz, w, d] of [
    [-B / 2, S / 2, B, S + 2 * B], [S + B / 2, S / 2, B, S + 2 * B],
    [S / 2, -B / 2, S, B], [S / 2, S + B / 2, S, B],
  ]) {
    const skirt = new THREE.Mesh(new THREE.PlaneGeometry(w, d), skirtMat)
    skirt.rotation.x = -Math.PI / 2
    skirt.position.set(cx, 2.7, cz)
    group.add(skirt)
  }

  // water
  if (grid.river.some(v => v)) {
    const waterMat = patchFow(new THREE.MeshLambertMaterial({ color: 0x2f86c0, transparent: true, opacity: 0.62, emissive: 0x0a2a44 }))
    const water = new THREE.Mesh(new THREE.PlaneGeometry(S, S, 1, 1), waterMat)
    water.rotation.x = -Math.PI / 2
    water.position.set(S / 2, -0.16, S / 2)
    water.name = 'water'
    water.renderOrder = 1
    group.add(water)
  }

  // ------------------------------------------------------------------ trees & rocks
  const rnd = mulberry32(seed * 7919 + 13)
  const trunkPos: THREE.Matrix4[] = []
  const conePos: { m: THREE.Matrix4; c: THREE.Color }[] = []
  const blobPos: { m: THREE.Matrix4; c: THREE.Color }[] = []
  const rockPos: { m: THREE.Matrix4; c: THREE.Color }[] = []
  const q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), v = new THREE.Vector3()
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const k = j * S + i
    if (grid.walk[k]) continue
    const wd = grid.wallDist[k]
    const cluster = vnoise(i * 0.18, j * 0.18)
    const x = i + 0.5 + (rnd() - 0.5) * 0.8, z = j + 0.5 + (rnd() - 0.5) * 0.8
    const h = grid.heightAt(x, z)
    if (wd >= 1.4 && rnd() < 0.14 + cluster * 0.22) {
      const sc = 0.75 + rnd() * 0.65
      const pine = cluster > 0.45 ? rnd() < 0.75 : rnd() < 0.3
      e.set(0, rnd() * Math.PI * 2, 0); q.setFromEuler(e)
      trunkPos.push(new THREE.Matrix4().compose(v.set(x, h + 0.5 * sc, z), q, s.set(sc, sc, sc)))
      const tint = 0.85 + rnd() * 0.3
      const cc = pine ? new THREE.Color(0x2e5a2c) : new THREE.Color(0x3d6d33)
      cc.multiplyScalar(tint)
      if (pine) conePos.push({ m: new THREE.Matrix4().compose(v.set(x, h + 2.1 * sc, z), q, s.set(sc, sc * (0.9 + rnd() * 0.4), sc)), c: cc })
      else blobPos.push({ m: new THREE.Matrix4().compose(v.set(x, h + 1.9 * sc, z), q, s.set(sc * 1.1, sc * 0.9, sc * 1.1)), c: cc })
    } else if (wd < 1.6 && wd > 0.3 && rnd() < 0.09) {
      const sc = 0.35 + rnd() * 0.6
      e.set(rnd() * 3, rnd() * 3, rnd() * 3); q.setFromEuler(e)
      const g = 0.75 + rnd() * 0.35
      rockPos.push({ m: new THREE.Matrix4().compose(v.set(x, h + 0.1, z), q, s.set(sc * 1.3, sc, sc * 1.2)), c: new THREE.Color(0x77705e).multiplyScalar(g) })
    }
  }
  const trunkMat = patchFow(new THREE.MeshLambertMaterial({ color: 0x5a3f28 }))
  const leafMat = patchFow(new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }))
  const rockMat = patchFow(new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }))
  const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, list: { m: THREE.Matrix4; c?: THREE.Color }[], shadow = true) => {
    const im = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length))
    list.forEach((it, n) => { im.setMatrixAt(n, it.m); if (it.c) im.setColorAt(n, it.c) })
    im.count = list.length
    im.castShadow = shadow
    im.receiveShadow = false
    im.instanceMatrix.needsUpdate = true
    if (im.instanceColor) im.instanceColor.needsUpdate = true
    im.computeBoundingSphere()
    group.add(im)
    return im
  }
  inst(new THREE.CylinderGeometry(0.14, 0.2, 1.0, 5), trunkMat, trunkPos.map(m => ({ m })))
  const coneGeo = new THREE.ConeGeometry(1.05, 2.9, 7)
  inst(coneGeo, leafMat, conePos)
  inst(new THREE.IcosahedronGeometry(1.15, 0), leafMat, blobPos)
  inst(new THREE.DodecahedronGeometry(1, 0), rockMat, rockPos)

  // ------------------------------------------------------------------ brush tufts
  const tufts: { m: THREE.Matrix4; c: THREE.Color }[] = []
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const k = j * S + i
    if (!grid.brush[k]) continue
    for (let n = 0; n < 4; n++) {
      const x = i + rnd(), z = j + rnd()
      const sc = 0.6 + rnd() * 0.6
      e.set((rnd() - 0.5) * 0.4, rnd() * 3, (rnd() - 0.5) * 0.4); q.setFromEuler(e)
      tufts.push({
        m: new THREE.Matrix4().compose(v.set(x, grid.heightAt(x, z) + 0.45 * sc, z), q, s.set(sc, sc * (0.8 + rnd() * 0.6), sc)),
        c: new THREE.Color(0x4f9a38).multiplyScalar(0.8 + rnd() * 0.4),
      })
    }
  }
  const brushMat = patchFow(new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }))
  const brushMesh = inst(new THREE.ConeGeometry(0.32, 1.1, 4), brushMat, tufts, false)
  brushMesh.name = 'brush'
  void fowUniforms
  return group
}
