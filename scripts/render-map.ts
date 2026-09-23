import { deflateSync } from 'zlib'
import { writeFileSync } from 'fs'
import { getMap, MapId } from '../src/game/mapdef'
import { Grid } from '../src/game/grid'

function png(w: number, h: number, rgb: Uint8Array) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.subarray(y * w * 3, (y + 1) * w * 3).forEach((v, i) => raw[y * (w * 3 + 1) + 1 + i] = v) }
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c })
  const crc = (b: Buffer) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0 }
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
for (const id of ['rift', 'aram'] as MapId[]) {
  const m = getMap(id); const g = new Grid(m); const S = m.size, SC = 4
  const W = S * SC; const img = new Uint8Array(W * W * 3)
  const set = (x: number, y: number, c: number[]) => { if (x < 0 || y < 0 || x >= W || y >= W) return; const o = (y * W + x) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2] }
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const k = j * S + i
    let c = [30, 40, 30]
    if (g.walk[k]) c = [70, 110, 60]
    if (g.lane[k]) c = [140, 120, 80]
    if (g.plaza[k]) c = g.plaza[k] === 1 ? [70, 90, 140] : [140, 70, 70]
    if (g.river[k]) c = [50, 90, 150]
    if (g.brush[k]) c = [40, 150, 50]
    for (let y = 0; y < SC; y++) for (let x = 0; x < SC; x++) set(i * SC + x, j * SC + y, c)
  }
  const dot = (x: number, z: number, r: number, c: number[]) => { for (let y = -r; y <= r; y++) for (let x2 = -r; x2 <= r; x2++) if (x2 * x2 + y * y <= r * r) set(Math.round(x * SC) + x2, Math.round(z * SC) + y, c) }
  for (const t of m.towers) dot(t.x, t.z, 5, t.team === 0 ? [80, 160, 255] : [255, 80, 80])
  for (const s of m.structs) dot(s.x, s.z, s.kind === 'nexus' ? 10 : 6, s.team === 0 ? [150, 200, 255] : [255, 150, 150])
  for (const c of m.camps) dot(c.x, c.z, c.epic ? 9 : 5, [240, 220, 60])
  for (const f of m.fountains) dot(f.x, f.z, 6, [255, 255, 255])
  for (const r of m.relics) dot(r[0], r[1], 3, [0, 255, 200])
  writeFileSync(`scripts/map-${id}.png`, png(W, W, img))
  console.log(id, 'towers', m.towers.length, 'structs', m.structs.length, 'camps', m.camps.length)
  const t0 = performance.now(); const p = g.findPath(8, 172, 172, 8); console.log('path ms', (performance.now() - t0).toFixed(1), 'len', p?.length)
}
