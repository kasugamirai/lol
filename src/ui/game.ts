import { World, SlotConfig } from '../game/world'
import { NetGame } from '../game/netgame'
import { GameRenderer, IndicatorSpec } from '../render/renderer'
import { Minimap } from '../render/minimap'
import { Hud } from './hud'
import { MatchRoom, slotTeam, ChatMsg } from '../net/room'
import { Unit } from '../game/unit'
import { Champion } from '../game/champion'
import { CastKey, Team } from '../game/types'
import { settings } from '../settings'
import { sfx } from '../audio'
import { el, esc, toast, champColor, fmtTime } from './dom'
import { ITEM_MAP } from '../game/data/items'
import { recordMatch, MatchRecord } from '../nostr/store'
import { dist } from '../util/math'
import type { SkillDef } from '../game/skills'

export interface GameOpts {
  room: MatchRoom
  me: { pk: string; name: string }
  slot: string | null
  onExit: (backToRoom: boolean) => void
}

const FORCE_RENDER = new URLSearchParams(location.search).has('forceRender')

const CAST_ERR: Record<string, string> = {
  cooldown: '技能冷却中', mana: '法力值不足', unlearned: '技能尚未学习', cc: '无法施放', notarget: '无效的目标', nocharge: '没有可用的守卫', busy: '',
}

export class GameScreen {
  readonly el: HTMLDivElement
  world: World
  net: NetGame
  ren: GameRenderer
  hud: Hud
  minimap: Minimap
  private running = true
  private raf = 0
  private worker: Worker | null = null
  private lastStep = performance.now()
  private mouse = { x: 0, y: 0, in: false }
  private amove = false
  private pendingKey: CastKey | null = null
  private rightHeld = false
  private rightNext = 0
  private spaceHeld = false
  private locked = settings.camLock
  private resultShown = false
  private minimapAt = 0
  private hoverAt = 0
  private fpsAcc = 0
  private fpsN = 0
  private errAt = 0
  private unsub: (() => void)[] = []
  private startedAt = Date.now()

  constructor(private o: GameOpts) {
    const info = o.room.info!
    this.el = el('div', 'game-screen')
    document.getElementById('app')!.appendChild(this.el)
    const slots: SlotConfig[] = o.room.entries().map(([k, s]) => ({
      slot: k, team: slotTeam(k), champ: s.champ ?? 'blaze', name: s.name, pk: s.pk, bot: s.kind === 'bot',
      spells: s.spells ?? ['flash', 'heal'], diff: s.diff ?? info.botDiff,
    }))
    const seed = info.seed ?? 1
    this.world = new World(info.map, slots, o.slot, seed)
    const w = this.world
    this.ren = new GameRenderer(this.el, w, { shadows: settings.shadows, quality: settings.quality })
    this.ren.locked = this.locked
    this.minimap = new Minimap(this.el, w)
    this.net = new NetGame(o.room, w, o.me, o.slot)
    this.hud = new Hud(this.el, w, {
      levelSkill: i => { if (w.me?.levelSkill(i)) sfx.play('click') },
      cast: k => this.castKey(k),
      buy: id => { const e = w.me?.buy(id); if (e) { toast(e, 'err', 1500); sfx.play('error') } else sfx.play('gold') },
      sell: s => { const e = w.me?.sell(s); if (e) toast(e, 'err', 1500); else sfx.play('gold') },
      recall: () => w.me?.cmdRecall(),
      chat: (t, all) => o.room.say({ n: o.me.name, pk: o.me.pk, t, tm: all ? -1 : w.myTeam }),
      quit: () => this.quit(),
      applySettings: () => {},
    }, {
      hostLabel: () => (w.isHost ? '👑主机' : this.net.peers > 0 ? '🔗同步' : '⏳') + ` ${this.net.peers + 1}人`,
      ping: () => o.room.yr.status === 'connected' ? '' : '⚠️离线',
    })
    w.hooks = {
      float: f => this.ren.overlay.addFloat(f),
      killFeed: (k, v) => this.hud.killFeed(k, v),
      announce: (t, sub, c) => { this.hud.announce(t, sub, c); sfx.play('announce') },
      sound: (n, x, z) => sfx.play(n, x, z),
      ping: (_t, x, z) => { this.minimap.ping(x, z); w.fx({ kind: 'ping', x, z, r: 1.4, color: 0xffd24a, dur: 2.2 }); sfx.play('ward') },
      gameOver: win => this.onGameOver(win),
    }
    this.minimap.onLeft = (x, z) => { this.locked = false; this.ren.centerOn(x, z) }
    this.minimap.onRight = (x, z) => { w.me?.cmdMove(x, z); w.fx({ kind: 'click', x, z, r: 0.9, color: 0x6aff8a, dur: 0.45 }) }

    // chat feed
    const onChat = (ev: any) => {
      for (const d of ev.changes.delta) {
        if (!d.insert) continue
        for (const m of d.insert as ChatMsg[]) {
          if (m.ts < this.startedAt - 1000) continue
          if (m.tm !== -1 && m.tm !== w.myTeam && !w.spectator) continue
          this.hud.chatLine(m.n, m.t, m.tm === -1 ? (m.pk === o.me.pk ? w.myTeam : -2) : m.tm, m.tm === -1)
        }
      }
    }
    o.room.chat.observe(onChat)
    this.unsub.push(() => o.room.chat.unobserve(onChat))
    this.unsub.push(o.room.onChange(() => {
      const m = o.room.info
      if (m?.status === 'ended' && w.winner === -1 && m.winner !== undefined) w.setWinner(m.winner as Team)
    }))

    this.bindInput()
    this.hud.chatLine('', w.me ? `欢迎来到${w.map.name}！按 P 打开商店购买装备，右键移动，QWER 释放技能。` : '你正在观战这场对局。', 0, false, true)
    if (w.me) this.hud.chatLine('', '升级技能：点击技能图标上方的 + 或按 Alt/Ctrl + Q/W/E/R', 0, false, true)
    this.hud.announce(w.map.name, '欢迎来到峡谷', '#f0e6d2')
    const blob = new Blob(['let t=setInterval(()=>postMessage(0),33);onmessage=e=>{if(e.data==="stop"){clearInterval(t);close()}}'], { type: 'text/javascript' })
    try {
      this.worker = new Worker(URL.createObjectURL(blob))
      this.worker.onmessage = () => {
        if (!this.running) return
        const now = performance.now()
        // keep simulating/syncing even when rAF is throttled (background tab, occluded window)
        if (now - this.lastStep > 45) this.step(now)
        if (now - this.lastFrame > 300 && (!document.hidden || FORCE_RENDER)) this.frame(now)
      }
    } catch { /* no worker */ }
    this.raf = requestAnimationFrame(this.frame)
  }

  // ------------------------------------------------------------------ loop
  private step(now: number) {
    let dt = (now - this.lastStep) / 1000
    this.lastStep = now
    if (dt <= 0) return 0
    dt = Math.min(dt, 0.25)
    const sub = dt > 0.05 ? Math.ceil(dt / 0.05) : 1
    for (let i = 0; i < sub; i++) this.world.update(dt / sub, now)
    this.net.tick(now)
    return dt
  }

  private lastFrame = performance.now()
  private frame = (tms: number) => {
    if (!this.running) return
    cancelAnimationFrame(this.raf)
    this.raf = requestAnimationFrame(this.frame)
    const now = performance.now()
    this.step(now)
    const dt = Math.min(0.25, (now - this.lastFrame) / 1000)
    this.lastFrame = now
    if (dt <= 0) return
    this.fpsAcc += dt; this.fpsN++
    if (this.fpsAcc > 0.5) { this.hud.fps = this.fpsN / this.fpsAcc; this.fpsAcc = 0; this.fpsN = 0 }
    this.updateInput(dt, now)
    const follow = this.locked || this.spaceHeld
    this.ren.locked = this.locked
    this.ren.updateCamera(dt, follow)
    sfx.listener.x = this.ren.camTarget.x
    sfx.listener.z = this.ren.camTarget.z
    this.updateIndicator()
    this.el.classList.toggle('dead', !!this.world.me?.dead)
    this.ren.render(dt, now / 1000)
    this.hud.update(dt, now)
    if (now - this.minimapAt > 90) {
      this.minimapAt = now
      this.minimap.draw(this.ren.cameraCorners())
    }
    void tms
  }

  // ------------------------------------------------------------------ input
  private bindInput() {
    const c = this.el
    const onMove = (e: MouseEvent) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.in = true }
    const onDown = (e: MouseEvent) => {
      sfx.unlock()
      if ((e.target as HTMLElement).closest('.hud-bottom, .shop, .scoreboard, .gmenu, .minimap, .chat')) return
      this.mouse.x = e.clientX; this.mouse.y = e.clientY
      const me = this.world.me
      if (e.button === 2) {
        e.preventDefault()
        if (this.pendingKey) { this.pendingKey = null; return }
        this.amove = false
        if (!me) return
        this.rightClick(true)
        this.rightHeld = true
        this.rightNext = performance.now() + 150
      } else if (e.button === 0) {
        if (!me) return
        if (this.amove) {
          this.amove = false
          const [x, z] = this.ren.screenToGround(e.clientX, e.clientY)
          const t = this.ren.pickUnit(e.clientX, e.clientY, u => u.team !== me.team && me.validTarget(u))
          if (t) me.cmdAttack(t)
          else me.cmdAttackMove(x, z)
          this.world.fx({ kind: 'click', x, z, r: 0.9, color: 0xff5050, dur: 0.45 })
        } else if (this.pendingKey) {
          this.castKey(this.pendingKey)
          this.pendingKey = null
        }
      }
    }
    const onUp = (e: MouseEvent) => { if (e.button === 2) this.rightHeld = false }
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.shop, .scoreboard, .chat, .gmenu')) return
      e.preventDefault()
      this.ren.setZoom(e.deltaY > 0 ? 0.08 : -0.08)
    }
    const onLeave = () => { this.mouse.in = false }
    const onKeyDown = (e: KeyboardEvent) => this.onKey(e, true)
    const onKeyUp = (e: KeyboardEvent) => this.onKey(e, false)
    const onResize = () => this.ren.resize()
    const onBlur = () => { this.rightHeld = false; this.spaceHeld = false; this.hud.showScoreboard(false) }
    c.addEventListener('mousemove', onMove)
    c.addEventListener('mousedown', onDown)
    window.addEventListener('mouseup', onUp)
    c.addEventListener('wheel', onWheel, { passive: false })
    c.addEventListener('mouseleave', onLeave)
    c.addEventListener('contextmenu', e => e.preventDefault())
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('resize', onResize)
    window.addEventListener('blur', onBlur)
    this.unsub.push(() => {
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('blur', onBlur)
    })
  }

  private rightClick(initial: boolean) {
    const w = this.world, me = w.me
    if (!me) return
    const t = this.ren.pickUnit(this.mouse.x, this.mouse.y, u => u !== me && u.team !== me.team && me.validTarget(u))
    if (t) {
      if (initial) {
        me.cmdAttack(t)
        w.fx({ kind: 'ring', x: t.x, z: t.z, r: t.radius + 0.6, color: 0xff4040, dur: 0.35 })
      }
      return
    }
    const [x, z] = this.ren.screenToGround(this.mouse.x, this.mouse.y)
    me.cmdMove(x, z)
    if (initial) w.fx({ kind: 'click', x, z, r: 0.9, color: 0x6aff8a, dur: 0.45 })
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const hud = this.hud
    if (hud.chatting) return
    const code = e.code
    const me = this.world.me
    if (down) {
      sfx.unlock()
      if (e.key === 'Enter') { hud.openChat(); e.preventDefault(); return }
      if (e.key === 'Escape') {
        if (this.pendingKey) { this.pendingKey = null; return }
        if (this.amove) { this.amove = false; return }
        if (!hud.closePanels()) hud.toggleMenu()
        return
      }
      if (code === 'Tab') { hud.showScoreboard(true); e.preventDefault(); return }
      if (code === 'Space') { this.spaceHeld = true; e.preventDefault(); return }
      if (code === 'KeyY') { this.locked = !this.locked; settings.camLock = this.locked; toast(this.locked ? '镜头已锁定' : '镜头已解锁（屏幕边缘/小地图移动镜头）', 'info', 1400); return }
      if (code === 'KeyP') { hud.toggleShop(); return }
      if (code.startsWith('Arrow')) return
      if (!me) return
      if (code === 'KeyQ' || code === 'KeyW' || code === 'KeyE' || code === 'KeyR') {
        const key = code[3] as CastKey
        if (e.ctrlKey || e.altKey || e.metaKey) {
          e.preventDefault()
          if (me.levelSkill('QWER'.indexOf(key))) sfx.play('click')
          return
        }
        if (e.repeat) return
        if (settings.castMode === 'indicator') this.pendingKey = key
        else this.castKey(key)
        return
      }
      if (code === 'KeyD' || code === 'KeyF') { if (!e.repeat) this.castKey(code[3] as CastKey); return }
      const dm = code.match(/^Digit([1-7])$/)
      if (dm) { if (!e.repeat) this.castKey(dm[1] as CastKey); return }
      if (code === 'KeyB') { me.cmdRecall(); return }
      if (code === 'KeyS') { me.cmdStop(); this.amove = false; return }
      if (code === 'KeyA') { this.amove = true; return }
      if (code === 'KeyG') {
        const [x, z] = this.ren.screenToGround(this.mouse.x, this.mouse.y)
        const ev = { e: 'ping' as const, tm: me.team, x: +x.toFixed(1), z: +z.toFixed(1), src: me.id, pk: 0 }
        this.world.emit(ev)
        this.world.handleEvent(ev, false)
        return
      }
    } else {
      if (code === 'Tab') hud.showScoreboard(false)
      if (code === 'Space') this.spaceHeld = false
      if (this.pendingKey && settings.castMode === 'indicator' && code === 'Key' + this.pendingKey) {
        this.castKey(this.pendingKey)
        this.pendingKey = null
      }
    }
  }

  private castKey(key: CastKey) {
    const w = this.world, me = w.me
    if (!me) return
    const def = me.castDef(key)
    if (!def) return
    const [gx, gz] = this.ren.screenToGround(this.mouse.x, this.mouse.y)
    let tid: string | undefined
    if (def.target === 'unit' || def.target === 'ally') {
      const team = def.unitTeam ?? (def.target === 'ally' ? 'ally' : 'enemy')
      const ok = (u: Unit) => {
        if (u.dead || u.isStructure || u.kind === 'ward') return false
        if (def.champOnly && !u.isChamp) return false
        if (team === 'enemy' && u.team === me.team) return false
        if (team === 'ally' && u.team !== me.team) return false
        if (u === me && def.target !== 'ally') return false
        return true
      }
      let u = this.ren.pickUnit(this.mouse.x, this.mouse.y, ok)
      if (!u) {
        let bd = 3
        for (const x of w.units.values()) {
          if (!ok(x) || !w.visibleToMe(x)) continue
          const d = dist(x.x, x.z, gx, gz)
          if (d < bd) { bd = d; u = x }
        }
      }
      tid = u?.id
    }
    const r = me.tryCast(key, gx, gz, tid)
    if (r !== 'ok' && r !== 'moving') {
      const msg = CAST_ERR[r]
      const now = performance.now()
      if (msg && now - this.errAt > 600) { this.errAt = now; this.hud.chatLine('', msg, 0, false, true); sfx.play('error') }
    }
  }

  private updateInput(dt: number, now: number) {
    const me = this.world.me
    if (this.rightHeld && me && now >= this.rightNext) {
      this.rightNext = now + 140
      this.rightClick(false)
    }
    if (now - this.hoverAt > 50 && this.mouse.in) {
      this.hoverAt = now
      this.ren.hovered = this.ren.pickUnit(this.mouse.x, this.mouse.y, u => u !== me)
      const h = this.ren.hovered
      this.el.classList.toggle('cur-attack', !!(h && me && h.team !== me.team) || this.amove)
    }
    // edge pan / arrows
    if (!this.locked && !this.spaceHeld) {
      const { w, h } = this.ren.size
      const m = 14, sp = 42 * dt * this.ren.zoom
      if (settings.edgePan && this.mouse.in) {
        if (this.mouse.x < m) this.ren.pan(-sp, 0)
        if (this.mouse.x > w - m) this.ren.pan(sp, 0)
        if (this.mouse.y < m) this.ren.pan(0, -sp)
        if (this.mouse.y > h - m) this.ren.pan(0, sp)
      }
    }
  }

  private updateIndicator() {
    const me = this.world.me
    if (!me || me.dead) { this.ren.setIndicator(null); return }
    if (this.pendingKey) {
      const def = me.castDef(this.pendingKey)
      if (def) { this.ren.setIndicator(this.specFor(def)); return }
    }
    if (this.amove) { this.ren.setIndicator(null, me.stats.range + me.radius); return }
    this.ren.setIndicator(null)
  }

  private specFor(def: SkillDef): IndicatorSpec {
    const [tx, tz] = this.ren.screenToGround(this.mouse.x, this.mouse.y)
    const i = def.ind
    switch (i.t) {
      case 'line': return { kind: 'line', range: def.range, width: i.w ?? 1, tx, tz }
      case 'circle': return { kind: 'circle', range: def.target === 'self' ? i.r ?? 2 : def.range, radius: i.r ?? 2, tx, tz }
      case 'cone': return { kind: 'cone', range: i.r ?? def.range, angle: i.a ?? 0.5, tx, tz }
      case 'range': return { kind: 'range', range: def.range, tx, tz }
      default: return { kind: 'none', range: 0, tx, tz }
    }
  }

  // ------------------------------------------------------------------ end of game
  private onGameOver(winner: Team) {
    if (this.resultShown) return
    this.resultShown = true
    const w = this.world
    const me = w.me
    const win = me ? winner === me.team : null
    sfx.play(win === false ? 'defeat' : 'victory')
    const info = this.o.room.info
    const dur = w.time
    const box = el('div', 'result-ov')
    const row = (c: Champion) => `<tr class="${c === me ? 'me' : ''}"><td><span class="sb-face" style="background:${champColor(c.def.color)}">${esc(c.def.name[0])}</span></td>
      <td>${esc(c.name)}${c.isBot ? ' <small>AI</small>' : ''}<br><small>${esc(c.def.name)} · Lv${c.level}</small></td><td>${c.kills}/${c.deaths}/${c.assists}</td><td>${c.cs}</td>
      <td>${Math.round(c.dmgToChamps) || '—'}</td><td class="sb-items">${c.items.map(i => `<span>${i ? ITEM_MAP[i]?.icon ?? '' : ''}</span>`).join('')}</td></tr>`
    box.innerHTML = `
      <div class="result-box">
        <div class="result-title ${win === false ? 'lose' : 'win'}">${win === null ? (winner === 0 ? '蓝色方胜利' : '红色方胜利') : win ? '胜利' : '失败'}</div>
        <div class="result-sub">${esc(w.map.name)} · 时长 ${fmtTime(dur)} · 蓝 ${w.teamKills[0]} : ${w.teamKills[1]} 红</div>
        ${[0, 1].map(t => `<div class="sb-team t${t}"><div class="sb-head">${t === 0 ? '蓝色方' : '红色方'}${t === winner ? ' 🏆' : ''}</div>
          <table><tr><th></th><th>玩家</th><th>K/D/A</th><th>补刀</th><th>英雄伤害</th><th>装备</th></tr>${w.champs.filter(c => c.team === t).map(row).join('')}</table></div>`).join('')}
        <div class="result-nostr">${me ? '正在将战绩写入 Nostr…' : ''}</div>
        <div class="result-btns"><button class="btn-gold" data-r="room">返回房间</button><button class="btn" data-r="menu">返回主页</button></div>
      </div>`
    this.el.appendChild(box)
    box.querySelector('[data-r=room]')!.addEventListener('click', () => this.exit(true))
    box.querySelector('[data-r=menu]')!.addEventListener('click', () => this.exit(false))
    if (me && info) {
      const rec: MatchRecord = {
        id: info.gameId ?? info.id + '-' + info.startedAt, map: info.map, mode: info.mm ? 'match' : info.priv ? 'practice' : 'custom',
        duration: Math.round(dur), endedAt: Date.now(), win: !!win, team: me.team, champ: me.def.id,
        k: me.kills, d: me.deaths, a: me.assists, cs: me.cs, level: me.level, gold: Math.round(me.goldTotal), items: me.items,
        bots: w.champs.some(c => c.isBot),
        players: w.champs.map(c => ({ n: c.name, pk: c.pk || undefined, c: c.def.id, t: c.team, k: c.kills, d: c.deaths, a: c.assists, bot: c.isBot || undefined })),
      }
      recordMatch(rec).then(r => {
        const n = box.querySelector('.result-nostr')
        if (n) n.textContent = r.published > 0 ? `✅ 战绩已签名并发布到 ${r.published} 个 Nostr 中继 · 积分 ${r.stats.rating}` : `⚠️ Nostr 中继发布失败，战绩已保存在本地 · 积分 ${r.stats.rating}`
      }).catch(() => {})
    }
  }

  private quit() {
    if (!confirm('确定要退出这场对局吗？（你的英雄将由主机托管）')) return
    this.exit(false)
  }

  private exit(toRoom: boolean) {
    this.destroy()
    this.o.onExit(toRoom)
  }

  destroy() {
    if (!this.running) return
    this.running = false
    cancelAnimationFrame(this.raf)
    this.worker?.postMessage('stop')
    this.worker?.terminate()
    for (const u of this.unsub) u()
    this.net.destroy()
    this.hud.destroy()
    this.ren.dispose()
    this.el.remove()
  }
}
