import { P2, polylineLength, pointAlong } from '../util/math'

export type Team = 0 | 1 | 2
export type LaneId = 'top' | 'mid' | 'bot'
export type MapId = 'rift' | 'aram'

export type Shape =
  | { t: 'circle'; x: number; z: number; r: number }
  | { t: 'capsule'; pts: P2[]; hw: number }

export type MonsterType =
  | 'gromp' | 'sentinel' | 'wolf' | 'wolfling' | 'raptor' | 'raptorling' | 'brambleback' | 'krug' | 'krugling'
  | 'dragon' | 'baron'

export interface CampDef {
  id: string
  name: string
  x: number; z: number
  face: number
  monsters: { type: MonsterType; dx: number; dz: number }[]
  first: number
  respawn: number
  buff?: 'blue' | 'red' | 'dragon' | 'baron'
  epic?: boolean
}
export interface TowerDef { id: string; team: 0 | 1; lane: LaneId | 'base'; tier: 1 | 2 | 3 | 4; x: number; z: number }
export interface StructDef { id: string; team: 0 | 1; kind: 'inhib' | 'nexus'; lane?: LaneId; x: number; z: number }

export interface MapDef {
  id: MapId
  name: string
  size: number
  laneIds: LaneId[]
  lanes: Partial<Record<LaneId, P2[]>>
  laneHW: number
  walk: Shape[]
  brush: Shape[]
  river: Shape[]
  plaza: { team: 0 | 1; shape: Shape }[]
  towers: TowerDef[]
  structs: StructDef[]
  fountains: { team: 0 | 1; x: number; z: number; r: number }[]
  spawns: [P2[], P2[]]
  camps: CampDef[]
  relics: P2[]
  startLevel: number
  startGold: number
  shopRadius: number
  /** spawn point arc length along each lane for minions */
  minionSpawnS: number
}

const S = 180
const reflect = (p: P2): P2 => [S - p[0], S - p[1]]
/** mirror across anti-diagonal: keeps the blue base fixed, swaps top<->bot sides */
const flipSide = (p: P2): P2 => [S - p[1], S - p[0]]

const mapShape = (s: Shape, f: (p: P2) => P2): Shape =>
  s.t === 'circle' ? (() => { const [x, z] = f([s.x, s.z]); return { t: 'circle', x, z, r: s.r } as Shape })()
    : { t: 'capsule', pts: s.pts.map(f), hw: s.hw }

function quad(shapes: Shape[]): Shape[] {
  const side = shapes.map(s => mapShape(s, flipSide))
  const all = [...shapes, ...side]
  return [...all, ...all.map(s => mapShape(s, reflect))]
}

function laneTowers(team: 0 | 1, lane: LaneId, pts: P2[], tiers: [number, number, number], inhibS: number) {
  const L = polylineLength(pts)
  const at = (s: number) => pointAlong(pts, team === 0 ? s : L - s)
  const t: TowerDef[] = []
  const tag = team === 0 ? 'b' : 'r'
  tiers.forEach((s, i) => {
    const [x, z] = at(s)
    t.push({ id: `t${tag}-${lane}-${3 - i}`, team, lane, tier: (3 - i) as 1 | 2 | 3, x, z })
  })
  const [ix, iz] = at(inhibS)
  const inhib: StructDef = { id: `i${tag}-${lane}`, team, kind: 'inhib', lane, x: ix, z: iz }
  return { towers: t, inhib }
}

function baseBits(team: 0 | 1, nexus: P2, towerDist: number, towerSpread: number) {
  // nexus towers flank the path toward the map center
  const dir = team === 0 ? [Math.SQRT1_2, -Math.SQRT1_2] : [-Math.SQRT1_2, Math.SQRT1_2]
  const perp = [dir[1], -dir[0]]
  const tag = team === 0 ? 'b' : 'r'
  const towers: TowerDef[] = [1, -1].map((sg, i) => ({
    id: `t${tag}-base-${i}`, team, lane: 'base' as const, tier: 4 as const,
    x: nexus[0] + dir[0] * towerDist + perp[0] * towerSpread * sg,
    z: nexus[1] + dir[1] * towerDist + perp[1] * towerSpread * sg,
  }))
  const nx: StructDef = { id: `n${tag}`, team, kind: 'nexus', x: nexus[0], z: nexus[1] }
  return { towers, nexus: nx }
}

function spawnRing(c: P2, r: number): P2[] {
  const out: P2[] = []
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3
    out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r])
  }
  return out
}

function buildRift(): MapDef {
  const top: P2[] = [[20, 160], [14, 138], [14, 40], [22, 22], [40, 14], [138, 14], [160, 20]]
  const mid: P2[] = [[20, 160], [34, 146], [146, 34], [160, 20]]
  const bot: P2[] = top.map(reflect).reverse()
  const lanes = { top, mid, bot }
  const laneHW = 6

  const walk: Shape[] = []
  for (const k of ['top', 'mid', 'bot'] as LaneId[]) walk.push({ t: 'capsule', pts: lanes[k], hw: laneHW })
  const blueBase: Shape = { t: 'circle', x: 14, z: 166, r: 30 }
  walk.push(blueBase, mapShape(blueBase, reflect))

  // blue top-side jungle (W quadrant); mirrored to the other 3 quadrants
  const jungle: Shape[] = [
    { t: 'capsule', pts: [[30, 144], [46, 108]], hw: 3.6 },
    { t: 'capsule', pts: [[46, 108], [40, 86]], hw: 3.6 },
    { t: 'capsule', pts: [[40, 86], [30, 62]], hw: 3.6 },
    { t: 'capsule', pts: [[30, 62], [16, 70]], hw: 3.4 },
    { t: 'capsule', pts: [[40, 86], [58, 80], [72, 72]], hw: 3.6 },
    { t: 'capsule', pts: [[46, 108], [66, 114]], hw: 3.4 },
    { t: 'capsule', pts: [[30, 62], [46, 48]], hw: 3.4 },
    { t: 'circle', x: 30, z: 62, r: 5.5 },
    { t: 'circle', x: 40, z: 86, r: 6.5 },
    { t: 'circle', x: 46, z: 108, r: 5.5 },
  ]
  walk.push(...quad(jungle))

  const river: Shape[] = [
    { t: 'capsule', pts: [[25, 25], [155, 155]], hw: 5.5 },
    { t: 'circle', x: 56, z: 56, r: 9 },
    { t: 'circle', x: 124, z: 124, r: 9 },
  ]

  const brushW: Shape[] = [
    { t: 'capsule', pts: [[20, 78], [20, 92]], hw: 2.2 },
    { t: 'circle', x: 22, z: 66, r: 3.0 },
    { t: 'circle', x: 46, z: 58, r: 2.8 },
    { t: 'capsule', pts: [[60, 114], [68, 106]], hw: 2.1 },
    { t: 'circle', x: 46, z: 92, r: 2.6 },
    { t: 'capsule', pts: [[62, 78], [68, 74]], hw: 2.0 },
  ]
  const brush = quad(brushW)

  const towers: TowerDef[] = []
  const structs: StructDef[] = []
  for (const team of [0, 1] as const) {
    for (const lane of ['top', 'mid', 'bot'] as LaneId[]) {
      const tiers: [number, number, number] = lane === 'mid' ? [72, 50, 31] : [106, 66, 31]
      const r = laneTowers(team, lane, lanes[lane], tiers, 22)
      towers.push(...r.towers)
      structs.push(r.inhib)
    }
    const nexus: P2 = team === 0 ? [20, 160] : [160, 20]
    const b = baseBits(team, nexus, 7, 3.4)
    towers.push(...b.towers)
    structs.push(b.nexus)
  }

  const campsW: CampDef[] = [
    { id: 'gromp', name: '魔沼蛙', x: 30, z: 62, face: 0, monsters: [{ type: 'gromp', dx: 0, dz: 0 }], first: 45, respawn: 110 },
    { id: 'blue', name: '蓝色哨兵', x: 40, z: 86, face: 0, monsters: [{ type: 'sentinel', dx: 0, dz: 0 }], first: 45, respawn: 150, buff: 'blue' },
    { id: 'wolves', name: '暗影狼', x: 46, z: 108, face: 0, monsters: [{ type: 'wolf', dx: 0, dz: 0 }, { type: 'wolfling', dx: 1.8, dz: 1.4 }, { type: 'wolfling', dx: -1.8, dz: 1.4 }], first: 45, respawn: 110 },
  ]
  const campsS: CampDef[] = [
    { id: 'krugs', name: '石甲虫', x: 0, z: 0, face: 0, monsters: [{ type: 'krug', dx: 0, dz: 0 }, { type: 'krugling', dx: 2, dz: 1 }], first: 45, respawn: 110 },
    { id: 'red', name: '红色荆棘兽', x: 0, z: 0, face: 0, monsters: [{ type: 'brambleback', dx: 0, dz: 0 }], first: 45, respawn: 150, buff: 'red' },
    { id: 'raptors', name: '锋喙鸟', x: 0, z: 0, face: 0, monsters: [{ type: 'raptor', dx: 0, dz: 0 }, { type: 'raptorling', dx: 1.6, dz: 1.2 }, { type: 'raptorling', dx: -1.6, dz: 1.2 }], first: 45, respawn: 110 },
  ]
  campsW.forEach((c, i) => { const [x, z] = flipSide([c.x, c.z]); campsS[i].x = x; campsS[i].z = z })
  const camps: CampDef[] = []
  for (const c of [...campsW, ...campsS]) {
    camps.push({ ...c, id: 'b-' + c.id })
    const [x, z] = reflect([c.x, c.z])
    camps.push({ ...c, id: 'r-' + c.id, x, z, monsters: c.monsters.map(m => ({ ...m, dx: -m.dx, dz: -m.dz })) })
  }
  camps.push({ id: 'baron', name: '纳什男爵', x: 56, z: 56, face: 0, monsters: [{ type: 'baron', dx: 0, dz: 0 }], first: 600, respawn: 300, buff: 'baron', epic: true })
  camps.push({ id: 'dragon', name: '远古巨龙', x: 124, z: 124, face: 0, monsters: [{ type: 'dragon', dx: 0, dz: 0 }], first: 180, respawn: 240, buff: 'dragon', epic: true })
  // monsters face toward the nearest walkable approach — roughly toward the map center
  for (const c of camps) c.face = Math.atan2(90 - c.x, 90 - c.z)

  const plaza = [
    { team: 0 as const, shape: blueBase },
    { team: 1 as const, shape: mapShape(blueBase, reflect) },
  ]
  return {
    id: 'rift', name: '星核峡谷', size: S, laneIds: ['top', 'mid', 'bot'], lanes, laneHW,
    walk, brush, river, plaza, towers, structs,
    fountains: [{ team: 0, x: 7, z: 173, r: 6 }, { team: 1, x: 173, z: 7, r: 6 }],
    spawns: [spawnRing([8, 172], 2.6), spawnRing([172, 8], 2.6)],
    camps, relics: [], startLevel: 1, startGold: 500, shopRadius: 15, minionSpawnS: 9,
  }
}

function buildAram(): MapDef {
  const mid: P2[] = [[38, 142], [142, 38]]
  const laneHW = 9.5
  const walk: Shape[] = [{ t: 'capsule', pts: mid, hw: laneHW }]
  const blueBase: Shape = { t: 'circle', x: 30, z: 150, r: 19 }
  walk.push(blueBase, mapShape(blueBase, reflect))
  const L = polylineLength(mid)
  const brushB: Shape[] = []
  const dir: P2 = [Math.SQRT1_2, -Math.SQRT1_2]
  const perp: P2 = [Math.SQRT1_2, Math.SQRT1_2]
  for (const s of [58, L - 58]) {
    for (const sg of [1, -1]) {
      const [cx, cz] = pointAlong(mid, s)
      const ox = cx + perp[0] * 7.5 * sg, oz = cz + perp[1] * 7.5 * sg
      brushB.push({ t: 'capsule', pts: [[ox - dir[0] * 3, oz - dir[1] * 3], [ox + dir[0] * 3, oz + dir[1] * 3]], hw: 2 })
    }
  }
  const towers: TowerDef[] = []
  const structs: StructDef[] = []
  for (const team of [0, 1] as const) {
    const r = laneTowers(team, 'mid', mid, [46, 34, 24], 16)
    // aram has only outer + inhib towers
    towers.push(r.towers[0], r.towers[2])
    structs.push(r.inhib)
    const nexus: P2 = team === 0 ? mid[0] : mid[1]
    const b = baseBits(team, nexus, 5.5, 3)
    towers.push(...b.towers)
    structs.push(b.nexus)
  }
  const relics: P2[] = [pointAlong(mid, 64), pointAlong(mid, L - 64)]
  return {
    id: 'aram', name: '极地大乱斗', size: S, laneIds: ['mid'], lanes: { mid }, laneHW,
    walk, brush: brushB, river: [], plaza: [{ team: 0, shape: blueBase }, { team: 1, shape: mapShape(blueBase, reflect) }],
    towers, structs,
    fountains: [{ team: 0, x: 23, z: 157, r: 5 }, { team: 1, x: 157, z: 23, r: 5 }],
    spawns: [spawnRing([24, 156], 2.4), spawnRing([156, 24], 2.4)],
    camps: [], relics, startLevel: 3, startGold: 1400, shopRadius: 12, minionSpawnS: 7,
  }
}

const cache: Partial<Record<MapId, MapDef>> = {}
export function getMap(id: MapId): MapDef {
  return (cache[id] ??= id === 'aram' ? buildAram() : buildRift())
}
