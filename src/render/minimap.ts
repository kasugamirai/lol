import type { World } from '../game/world'
import { Champion } from '../game/champion'
import { Minion, Monster, Ward } from '../game/npc'

export class Minimap {
  readonly el: HTMLDivElement
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private bg: HTMLCanvasElement
  private fog: HTMLCanvasElement
  private fogImg: ImageData
  private fogVersion = -1
  private size = 220
  private dpr = 1
  pings: { x: number; z: number; t0: number; color: string }[] = []
  onLeft: ((x: number, z: number) => void) | null = null
  onRight: ((x: number, z: number) => void) | null = null

  constructor(parent: HTMLElement, private w: World) {
    this.el = document.createElement('div')
    this.el.className = 'minimap'
    this.canvas = document.createElement('canvas')
    this.el.appendChild(this.canvas)
    parent.appendChild(this.el)
    this.ctx = this.canvas.getContext('2d')!
    const S = w.map.size
    this.bg = document.createElement('canvas')
    this.bg.width = S; this.bg.height = S
    this.fog = document.createElement('canvas')
    this.fog.width = S; this.fog.height = S
    this.fogImg = this.fog.getContext('2d')!.createImageData(S, S)
    this.renderBg()
    this.resize(220)
    let dragging = false
    const toWorld = (e: MouseEvent): [number, number] => {
      const r = this.canvas.getBoundingClientRect()
      return [((e.clientX - r.left) / r.width) * S, ((e.clientY - r.top) / r.height) * S]
    }
    this.canvas.addEventListener('mousedown', e => {
      e.preventDefault()
      e.stopPropagation()
      const [x, z] = toWorld(e)
      if (e.button === 0) { dragging = true; this.onLeft?.(x, z) }
      else if (e.button === 2) this.onRight?.(x, z)
    })
    window.addEventListener('mousemove', e => { if (dragging) { const [x, z] = toWorld(e); this.onLeft?.(Math.max(0, Math.min(S, x)), Math.max(0, Math.min(S, z))) } })
    window.addEventListener('mouseup', () => { dragging = false })
    this.canvas.addEventListener('contextmenu', e => e.preventDefault())
  }

  resize(px: number) {
    this.size = px
    this.dpr = Math.min(2, window.devicePixelRatio || 1)
    this.canvas.width = Math.round(px * this.dpr)
    this.canvas.height = Math.round(px * this.dpr)
    this.canvas.style.width = px + 'px'
    this.canvas.style.height = px + 'px'
  }

  private renderBg() {
    const g = this.w.grid
    const S = g.S
    const ctx = this.bg.getContext('2d')!
    const img = ctx.createImageData(S, S)
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const k = j * S + i
      let c = [18, 30, 22]
      if (g.walk[k]) c = [52, 78, 54]
      if (g.lane[k]) c = [112, 98, 72]
      if (g.plaza[k]) c = g.plaza[k] === 1 ? [52, 70, 110] : [110, 56, 56]
      if (g.river[k]) c = [40, 92, 130]
      if (g.brush[k]) c = [44, 104, 46]
      if (!g.walk[k] && g.wallDist[k] < 1.5) c = [34, 48, 34]
      const o = k * 4
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
  }

  ping(x: number, z: number, color = '#ffd24a') {
    this.pings.push({ x, z, t0: performance.now(), color })
  }

  draw(camCorners: [number, number][] | null) {
    const w = this.w
    const ctx = this.ctx
    const S = w.map.size
    const px = this.size
    const k = px / S
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(this.bg, 0, 0, px, px)
    // fog
    if (!w.spectator) {
      if (w.vision.version !== this.fogVersion) {
        this.fogVersion = w.vision.version
        const vis = w.vision.vis[w.myTeam as 0 | 1]
        const d = this.fogImg.data
        for (let i = 0; i < vis.length; i++) {
          d[i * 4 + 3] = vis[i] ? 0 : 140
        }
        this.fog.getContext('2d')!.putImageData(this.fogImg, 0, 0)
      }
      ctx.drawImage(this.fog, 0, 0, px, px)
    }
    const myTeam = w.myTeam
    const teamCol = (t: number) => (w.spectator ? (t === 0 ? '#4a9aff' : '#ff5a5a') : t === myTeam ? '#4a9aff' : '#ff5a5a')
    // structures
    for (const s of [...w.towers, ...w.structs]) {
      const x = s.x * k, y = s.z * k
      if (s.dead) {
        ctx.strokeStyle = 'rgba(160,160,160,0.7)'
        ctx.lineWidth = 1.2
        ctx.beginPath(); ctx.moveTo(x - 3, y - 3); ctx.lineTo(x + 3, y + 3); ctx.moveTo(x + 3, y - 3); ctx.lineTo(x - 3, y + 3); ctx.stroke()
        continue
      }
      ctx.fillStyle = teamCol(s.team)
      ctx.strokeStyle = '#0a0a0a'
      ctx.lineWidth = 1
      if (s.kind === 'tower') { ctx.fillRect(x - 3.5, y - 3.5, 7, 7); ctx.strokeRect(x - 3.5, y - 3.5, 7, 7) }
      else if (s.kind === 'inhib') { ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke() }
      else {
        ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 7, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 7, y); ctx.closePath(); ctx.fill(); ctx.stroke()
      }
    }
    // relics
    w.map.relics.forEach((r, i) => {
      if (!w.relicsUp[i]) return
      ctx.fillStyle = '#5aff9a'
      ctx.beginPath(); ctx.arc(r[0] * k, r[1] * k, 2.5, 0, Math.PI * 2); ctx.fill()
    })
    // units
    for (const u of w.units.values()) {
      if (u.dead || !w.visibleToMe(u)) continue
      if (u instanceof Minion) {
        ctx.fillStyle = teamCol(u.team)
        ctx.fillRect(u.x * k - 1.5, u.z * k - 1.5, 3, 3)
      } else if (u instanceof Monster) {
        const epic = u.mt === 'dragon' || u.mt === 'baron'
        ctx.fillStyle = epic ? '#c880ff' : '#e8b84a'
        ctx.beginPath(); ctx.arc(u.x * k, u.z * k, epic ? 5 : 3, 0, Math.PI * 2); ctx.fill()
        ctx.strokeStyle = '#000'; ctx.lineWidth = 0.8; ctx.stroke()
      } else if (u instanceof Ward) {
        ctx.fillStyle = u.team === myTeam ? '#ffe68a' : '#ff8a6a'
        ctx.beginPath(); ctx.arc(u.x * k, u.z * k, 2.2, 0, Math.PI * 2); ctx.fill()
      }
    }
    // champions (on top)
    const champs = [...w.champs].sort((a, b) => (a === w.me ? 1 : 0) - (b === w.me ? 1 : 0))
    for (const c of champs) {
      if (c.dead || !w.visibleToMe(c)) continue
      this.drawChamp(c, k, teamCol(c.team))
    }
    // camera
    if (camCorners) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'
      ctx.lineWidth = 1.2
      ctx.beginPath()
      camCorners.forEach(([x, z], i) => (i ? ctx.lineTo(x * k, z * k) : ctx.moveTo(x * k, z * k)))
      ctx.closePath()
      ctx.stroke()
    }
    // pings
    const now = performance.now()
    this.pings = this.pings.filter(p => now - p.t0 < 2500)
    for (const p of this.pings) {
      const t = ((now - p.t0) / 700) % 1
      ctx.strokeStyle = p.color
      ctx.globalAlpha = 1 - t
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(p.x * k, p.z * k, 4 + t * 12, 0, Math.PI * 2); ctx.stroke()
      ctx.globalAlpha = 1
    }
    // border
    ctx.strokeStyle = '#7a6538'
    ctx.lineWidth = 2
    ctx.strokeRect(1, 1, px - 2, px - 2)
  }

  private drawChamp(c: Champion, k: number, border: string) {
    const ctx = this.ctx
    const x = c.x * k, y = c.z * k
    const me = c === this.w.me
    const r = me ? 8 : 7
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = '#' + c.def.color.toString(16).padStart(6, '0')
    ctx.fill()
    ctx.lineWidth = me ? 2.5 : 2
    ctx.strokeStyle = me ? '#ffe070' : border
    ctx.stroke()
    ctx.fillStyle = '#111'
    ctx.font = `700 ${me ? 10 : 9}px "PingFang SC", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(c.def.name[0], x, y + 0.5)
  }
}
