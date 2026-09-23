import type { World, FloatText } from '../game/world'
import { Unit } from '../game/unit'
import { Champion } from '../game/champion'
import { F } from '../game/types'

export type Projector = (x: number, y: number, z: number, out: { x: number; y: number }) => boolean

const CC_TEXT: [number, string][] = [
  [F.STUN, '眩晕'], [F.KNOCKUP, '击飞'], [F.ROOT, '禁锢'], [F.SILENCE, '沉默'], [F.STASIS, '凝滞'], [F.SLOW, '减速'],
]

export class Overlay {
  readonly canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private floats: FloatText[] = []
  private dpr = 1
  private w = 1
  private h = 1
  private p = { x: 0, y: 0 }

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'overlay-canvas'
    parent.appendChild(this.canvas)
    this.ctx = this.canvas.getContext('2d')!
  }

  resize(w: number, h: number, dpr: number) {
    this.w = w; this.h = h; this.dpr = dpr
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.canvas.style.width = w + 'px'
    this.canvas.style.height = h + 'px'
  }

  addFloat(f: FloatText) {
    this.floats.push(f)
    if (this.floats.length > 80) this.floats.shift()
  }

  draw(w: World, heightAt: (x: number, z: number) => number, project: Projector, hovered: Unit | null) {
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.w, this.h)
    const me = w.me
    const p = this.p
    // non-champions first, champions on top
    const champs: Champion[] = []
    for (const u of w.units.values()) {
      if (u instanceof Champion) { champs.push(u); continue }
      if (u.dead) continue
      if (!w.visibleToMe(u)) continue
      const y = heightAt(u.x, u.z) + u.height + u.airY
      if (!project(u.x, y, u.z, p)) continue
      if (p.x < -60 || p.y < -30 || p.x > this.w + 60 || p.y > this.h + 30) continue
      this.drawNpcBar(u, p.x, p.y, me, hovered === u)
    }
    for (const c of champs) {
      if (c.dead) continue
      if (!w.visibleToMe(c)) continue
      const y = heightAt(c.x, c.z) + c.height * (c.def.model === 'golem' ? 1.2 : 1) + c.airY
      if (!project(c.x, y, c.z, p)) continue
      if (p.x < -80 || p.y < -60 || p.x > this.w + 80 || p.y > this.h + 60) continue
      this.drawChampBar(c, p.x, p.y, w)
    }
    // floating combat text
    const now = w.now
    this.floats = this.floats.filter(f => now - f.t0 < f.dur)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const f of this.floats) {
      const k = (now - f.t0) / f.dur
      if (!project(f.x, heightAt(f.x, f.z) + f.y, f.z, p)) continue
      const alpha = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4
      const rise = 46 * Math.sqrt(k)
      const pop = k < 0.12 ? 1 + (0.12 - k) * 3 : 1
      ctx.globalAlpha = alpha
      ctx.font = `800 ${Math.round(f.size * pop)}px "Segoe UI", "PingFang SC", sans-serif`
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(0,0,0,0.85)'
      ctx.strokeText(f.text, p.x, p.y - rise)
      ctx.fillStyle = f.color
      ctx.fillText(f.text, p.x, p.y - rise)
    }
    ctx.globalAlpha = 1
  }

  private bar(x: number, y: number, W: number, H: number, frac: number, color: string, shield = 0, ticks = 0) {
    const ctx = this.ctx
    ctx.fillStyle = 'rgba(8,10,14,0.88)'
    ctx.fillRect(x - 1, y - 1, W + 2, H + 2)
    const fw = Math.max(0, Math.min(1, frac)) * W
    ctx.fillStyle = color
    ctx.fillRect(x, y, fw, H)
    // gloss
    ctx.fillStyle = 'rgba(255,255,255,0.18)'
    ctx.fillRect(x, y, fw, Math.max(1, H * 0.35))
    if (shield > 0) {
      ctx.fillStyle = 'rgba(235,235,235,0.9)'
      ctx.fillRect(x + fw, y, Math.min(W - fw, shield * W), H)
    }
    if (ticks > 1) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      const step = W / ticks
      for (let i = 1; i < ticks; i++) ctx.fillRect(Math.round(x + i * step), y, 1, H * (i % 10 === 0 ? 1 : 0.55))
    }
  }

  private drawChampBar(c: Champion, sx: number, sy: number, w: World) {
    const ctx = this.ctx
    const me = w.me
    const W = 98, H = 10
    const x0 = Math.round(sx - W / 2 + 10), y0 = Math.round(sy - 30)
    const color = c === me ? '#4fd65a' : c.team === w.myTeam && !w.spectator ? '#3f9dff' : w.spectator ? (c.team === 0 ? '#3f9dff' : '#e84545') : '#e84545'
    const maxHp = Math.max(1, c.maxHp)
    const sh = c.shieldTotal()
    const total = Math.max(maxHp, c.hp + sh)
    this.bar(x0, y0, W, H, c.hp / total, color, sh / total, Math.min(40, Math.floor(total / 100)))
    // mana
    if (c.maxMp > 0) {
      ctx.fillStyle = 'rgba(8,10,14,0.88)'
      ctx.fillRect(x0 - 1, y0 + H + 1, W + 2, 5)
      ctx.fillStyle = '#4a86ff'
      ctx.fillRect(x0, y0 + H + 2, Math.max(0, Math.min(1, c.mp / c.maxMp)) * W, 3)
    }
    // level box
    ctx.fillStyle = 'rgba(14,16,22,0.95)'
    ctx.fillRect(x0 - 22, y0 - 2, 20, H + 9)
    ctx.strokeStyle = '#b8964a'
    ctx.lineWidth = 1
    ctx.strokeRect(x0 - 21.5, y0 - 1.5, 19, H + 8)
    ctx.fillStyle = '#f0d890'
    ctx.font = '700 11px "Segoe UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(c.level), x0 - 12, y0 + H / 2 + 2)
    // name
    ctx.font = '600 12px "PingFang SC", "Microsoft YaHei", sans-serif'
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(0,0,0,0.8)'
    const nm = c.name + (c.isBot ? '' : '')
    ctx.strokeText(nm, x0 + W / 2 - 10, y0 - 10)
    ctx.fillStyle = c === me ? '#e8ffe0' : '#f4f4f4'
    ctx.fillText(nm, x0 + W / 2 - 10, y0 - 10)
    // cc / status
    for (const [flag, text] of CC_TEXT) {
      if (c.fl & flag) {
        ctx.font = '700 11px "PingFang SC", sans-serif'
        ctx.strokeText(text, x0 + W / 2, y0 + H + 16)
        ctx.fillStyle = flag === F.SLOW ? '#9ad0ff' : '#ffcf4a'
        ctx.fillText(text, x0 + W / 2, y0 + H + 16)
        break
      }
    }
    if (c.fl & F.RECALL) {
      ctx.font = '700 11px "PingFang SC", sans-serif'
      ctx.strokeText('回城中', x0 + W / 2, y0 + H + 16)
      ctx.fillStyle = '#8ac8ff'
      ctx.fillText('回城中', x0 + W / 2, y0 + H + 16)
    }
  }

  private drawNpcBar(u: Unit, sx: number, sy: number, me: Champion | null, hovered: boolean) {
    const ctx = this.ctx
    const myTeam = me ? me.team : 0
    let W = 36, H = 4, color = u.team === myTeam ? '#3f8dff' : '#e84545', ticks = 0
    if (u.kind === 'tower') { W = 92; H = 8; ticks = Math.floor(u.maxHp / 500) }
    else if (u.kind === 'inhib' || u.kind === 'nexus') { W = 110; H = 9; ticks = Math.floor(u.maxHp / 500) }
    else if (u.kind === 'monster') {
      const epic = u.type === 'dragon' || u.type === 'baron'
      W = epic ? 150 : ['sentinel', 'brambleback'].includes(u.type) ? 80 : 56
      H = epic ? 10 : 6
      color = '#e8a93a'
    } else if (u.kind === 'ward') { W = 26; H = 4 }
    if (u.team === 2) color = '#e8a93a'
    const x0 = Math.round(sx - W / 2), y0 = Math.round(sy - (u.kind === 'minion' ? 6 : 12))
    this.bar(x0, y0, W, H, u.hp / Math.max(1, u.maxHp), color, 0, ticks)
    // last-hit helper
    if (me && u.kind === 'minion' && u.team !== myTeam && u.hp <= me.stats.ad * 0.95) {
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.strokeRect(x0 - 1.5, y0 - 1.5, W + 3, H + 3)
    }
    if (hovered) {
      ctx.strokeStyle = '#ffd24a'
      ctx.lineWidth = 1
      ctx.strokeRect(x0 - 2.5, y0 - 2.5, W + 5, H + 5)
    }
    if (u.kind === 'monster' && (u.type === 'dragon' || u.type === 'baron') || u.kind === 'nexus') {
      ctx.font = '700 12px "PingFang SC", sans-serif'
      ctx.textAlign = 'center'
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(0,0,0,0.8)'
      ctx.strokeText(u.name, sx, y0 - 9)
      ctx.fillStyle = '#ffe6b0'
      ctx.fillText(u.name, sx, y0 - 9)
    }
  }
}
