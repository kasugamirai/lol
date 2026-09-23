import type { World } from '../game/world'
import type { GameRenderer, IndicatorSpec } from '../render/renderer'
import type { Hud } from './hud'
import type { Unit } from '../game/unit'
import type { CastResult, Champion } from '../game/champion'
import type { SkillDef } from '../game/skills'
import type { CastKey } from '../game/types'
import { settings } from '../settings'
import { sfx } from '../audio'
import { DEV, uiScale, safeInsets } from './device'
import * as TL from './touchlogic'
import { dist } from '../util/math'

/** what TouchControls needs from the game screen (avoids a circular import with game.ts) */
export interface TouchHost {
  world: World
  ren: GameRenderer
  hud: Hud
  root: HTMLElement
  minimapResize(px: number): void
  doCast(key: CastKey, x: number, z: number, tid?: string, quiet?: boolean): CastResult
  castErr(r: CastResult): void
  specFor(def: SkillDef, tx?: number, tz?: number, color?: number): IndicatorSpec
  ping(x: number, z: number): void
}

type Gesture =
  | { kind: 'native' }
  | { kind: 'inert' }
  | { kind: 'ui'; el: HTMLElement; x0: number; y0: number; moved: number; t0: number; multi: boolean }
  | { kind: 'joy' }
  | { kind: 'atk' }
  | { kind: 'skill'; key: CastKey; slot: HTMLElement }
  | { kind: 'world'; x0: number; y0: number; t0: number; moved: number }
  | { kind: 'pan'; lx: number; ly: number }

/** bx/by = logical base (drag origin); ox/oy = visual offset of the drawn ring when the base had to be clamped on screen */
interface JoyState { id: number; bx: number; by: number; ox: number; oy: number; active: boolean; ux: number; uz: number; lastIssue: number; lastAng: number; moved: boolean; stopped: boolean }
interface AimState { id: number; key: CastKey; def: SkillDef; ox: number; oy: number; dx: number; dy: number; overCancel: boolean }
/** lastId = the unit this gesture last ordered an attack on (its chase is ours to leash / stop) */
interface AtkState { mode: TL.AtkMode; held: boolean; target: Unit | null; nextEval: number; pulseUntil: number; t0: number; lastIssue: number; lastId: string | null; btn: HTMLElement | null }

/** elements that keep native behaviour (scrolling, focus, clicks) */
const NATIVE = 'input, select, textarea, .shop, .scoreboard, .gmenu, .result-ov, .chat.open'
const INERT_CAST: CastResult[] = ['unlearned', 'mana', 'nocharge', 'none', 'dead', 'cc']
/** a button press held this long may get no native click (Android long-press is 400 ms since Android 12);
 *  the router clicks it — a native click that still arrives is dropped by the dedupe */
const UI_LONG_MS = 300

/**
 * Wild Rift style touch controls: left virtual joystick, right attack button + skill buttons with
 * tap-to-smart-cast / drag-to-aim, cancel zone, tap-to-focus targets. Pointer-event based, multi-touch.
 */
export class TouchControls {
  lookHeld = false
  lastTouch = 0
  private w: World
  private gestures = new Map<number, Gesture>()
  private joy: JoyState | null = null
  private aim: AimState | null = null
  private atk: AtkState | null = null
  private queued: { key: CastKey; rx: number; rz: number; tid?: string; until: number } | null = null
  private focus: Unit | null = null
  private aimTarget: Unit | null = null
  private castOrderAt = -1e9
  private rangeFlashUntil = 0
  private uiFired: { el: HTMLElement; t: number } | null = null
  private s = 1
  private ins = { l: 0, r: 0, b: 0, t: 0 }
  private rest = { x: 120, y: 280 }
  private cancelC = { x: -999, y: -999 }
  private vw = 844
  private vh = 390
  // DOM
  private layer: HTMLElement
  private joyEl: HTMLDivElement
  private joyKnob: HTMLDivElement
  private aimEl: HTMLDivElement
  private aimKnob: HTMLDivElement
  private cancelEl: HTMLDivElement
  private atkBtns: HTMLElement[] = []
  private dbg: HTMLDivElement | null = null
  private off: (() => void)[] = []

  constructor(private host: TouchHost) {
    this.w = host.world
    const layer = host.hud.tcLayer ?? host.hud.root
    this.layer = layer
    const L = TL.TC_LAYOUT
    const mkBtn = (mode: TL.AtkMode, icon: string, label: string, spec: [number, number, number]) => {
      const b = document.createElement('div')
      b.className = 'tc-rb tc-atk tc-atk-' + mode
      b.dataset.tc = mode
      b.setAttribute('aria-label', label)
      b.innerHTML = `<span>${icon}</span>`
      b.style.setProperty('--dx', spec[0] + 'px')
      b.style.setProperty('--dy', spec[1] + 'px')
      b.style.setProperty('--r', spec[2] / 2 + 'px')
      layer.appendChild(b)
      this.atkBtns.push(b)
    }
    // spectators only pan the camera: no attack buttons, no joystick
    if (this.w.me) {
      mkBtn('main', '⚔️', '攻击', L.main)
      mkBtn('minion', '🗡', '补刀', L.minion)
      mkBtn('tower', '🏰', '推塔', L.tower)
    }
    this.joyEl = document.createElement('div')
    this.joyEl.className = 'tc-joy'
    this.joyEl.innerHTML = '<div class="tc-joy-ring"></div>'
    this.joyKnob = document.createElement('div')
    this.joyKnob.className = 'tc-joy-knob'
    this.joyEl.appendChild(this.joyKnob)
    if (this.w.me) layer.appendChild(this.joyEl)
    this.aimEl = document.createElement('div')
    this.aimEl.className = 'tc-aim'
    this.aimEl.innerHTML = '<div class="tc-aim-ring"></div>'
    this.aimKnob = document.createElement('div')
    this.aimKnob.className = 'tc-aim-knob'
    this.aimEl.appendChild(this.aimKnob)
    layer.appendChild(this.aimEl)
    this.cancelEl = document.createElement('div')
    this.cancelEl.className = 'tc-rb tc-cancel'
    this.cancelEl.innerHTML = '<span>✕</span><small>取消</small>'
    this.cancelEl.style.setProperty('--dx', L.cancel[0] + 'px')
    this.cancelEl.style.setProperty('--dy', L.cancel[1] + 'px')
    this.cancelEl.style.setProperty('--r', L.cancel[2] / 2 + 'px')
    layer.appendChild(this.cancelEl)
    if (DEV.touchDebug) {
      this.dbg = document.createElement('div')
      this.dbg.className = 'tc-debug'
      host.root.appendChild(this.dbg)
    }

    const root = host.root
    const opt = { passive: false } as AddEventListenerOptions
    const down = (e: PointerEvent) => this.onDown(e)
    const move = (e: PointerEvent) => this.onMove(e)
    const up = (e: PointerEvent) => this.onEnd(e, false)
    const cancel = (e: PointerEvent) => this.onEnd(e, true)
    const lost = (e: PointerEvent) => { if (this.gestures.has(e.pointerId)) this.onEnd(e, true) }
    const click = (e: MouseEvent) => {
      const f = this.uiFired
      if (!f || !e.isTrusted) return
      if (performance.now() - f.t < 700 && f.el.contains(e.target as Node)) {
        e.stopPropagation()
        e.preventDefault()
        this.uiFired = null
      }
    }
    const sel = (e: Event) => e.preventDefault()
    const vis = () => { if (document.hidden) this.cancelAll() }
    const blur = () => this.cancelAll()
    root.addEventListener('pointerdown', down, opt)
    root.addEventListener('pointermove', move, opt)
    root.addEventListener('pointerup', up, opt)
    root.addEventListener('pointercancel', cancel, opt)
    root.addEventListener('lostpointercapture', lost)
    root.addEventListener('click', click, { capture: true })
    root.addEventListener('selectstart', sel)
    document.addEventListener('visibilitychange', vis)
    window.addEventListener('blur', blur)
    window.addEventListener('pagehide', blur)
    this.off.push(() => {
      root.removeEventListener('pointerdown', down, opt)
      root.removeEventListener('pointermove', move, opt)
      root.removeEventListener('pointerup', up, opt)
      root.removeEventListener('pointercancel', cancel, opt)
      root.removeEventListener('lostpointercapture', lost)
      root.removeEventListener('click', click, { capture: true })
      root.removeEventListener('selectstart', sel)
      document.removeEventListener('visibilitychange', vis)
      window.removeEventListener('blur', blur)
      window.removeEventListener('pagehide', blur)
    })
    this.relayout()
  }

  // ------------------------------------------------------------------ layout
  relayout() {
    const s = (this.s = uiScale())
    this.host.root.style.setProperty('--s', String(s))
    this.ins = safeInsets()
    const rect = this.host.root.getBoundingClientRect()
    this.vw = rect.width || innerWidth
    this.vh = rect.height || innerHeight
    this.host.minimapResize(Math.round(116 * s))
    this.rest = { x: this.ins.l + 118 * s, y: this.vh - this.ins.b - 104 * s }
    this.host.root.classList.toggle('tc-narrow', this.vw < 740)
    const cr = this.cancelEl.getBoundingClientRect()
    this.cancelC = cr.width ? { x: cr.left + cr.width / 2, y: cr.top + cr.height / 2 } : this.cancelC
    if (!this.joy) this.drawJoy(this.rest.x, this.rest.y, this.rest.x, this.rest.y, false)
  }

  // ------------------------------------------------------------------ router
  private isTouchPtr(e: PointerEvent) {
    return e.pointerType !== 'mouse' || DEV.mouseTouch
  }

  private onDown(e: PointerEvent) {
    if (!this.isTouchPtr(e)) return
    const now = performance.now()
    this.lastTouch = now
    const t = e.target as HTMLElement
    const id = e.pointerId
    // a new touch sequence: any trusted click still pending belongs to an earlier one
    this.uiFired = null
    if (t.closest(NATIVE)) { this.gestures.set(id, { kind: 'native' }); return }
    // cancelling pointerdown also cancels the focus change: close the chat / blur a focused field ourselves
    if (this.host.hud.chatting) this.host.hud.closeChat()
    const ae = document.activeElement as HTMLElement | null
    if (ae && ae !== document.body && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && this.host.root.contains(ae)) ae.blur()
    e.preventDefault()
    if (this.gestures.size >= 5) return
    const x = e.clientX, y = e.clientY
    // browsers drop the native click of a tap that overlapped another finger: remember it on every live button press
    const others = [...this.gestures.values()].some(g => g.kind !== 'native')
    for (const g of this.gestures.values()) if (g.kind === 'ui') g.multi = true
    const tc = t.closest('[data-tc]') as HTMLElement | null
    const ui = !tc ? (t.closest('.lvlup, button, [data-act], [data-tip]:not(.slot):not(.islot)') as HTMLElement | null) : null
    if (ui) { this.gestures.set(id, { kind: 'ui', el: ui, x0: x, y0: y, moved: 0, t0: now, multi: others }); return }
    try { this.host.root.setPointerCapture(id) } catch { /* synthetic pointer ids */ }
    const me = this.w.me
    if (!me) { this.gestures.set(id, { kind: 'pan', lx: x, ly: y }); return }
    if (tc) {
      if (this.atk?.held) { this.gestures.set(id, { kind: 'inert' }); return }
      this.gestures.set(id, { kind: 'atk' })
      this.startAtk(tc.dataset.tc as TL.AtkMode, tc, now)
      return
    }
    const slot = t.closest('.slot[data-key], .islot[data-key]') as HTMLElement | null
    if (slot) {
      const key = slot.dataset.key as CastKey
      this.gestures.set(id, { kind: 'skill', key, slot })
      this.startSkill(id, key, slot, x, y, now)
      return
    }
    if (!this.joy && this.inJoyZone(x, y)) {
      this.gestures.set(id, { kind: 'joy' })
      this.startJoy(id, x, y, now)
      return
    }
    this.gestures.set(id, { kind: 'world', x0: x, y0: y, t0: now, moved: 0 })
  }

  private onMove(e: PointerEvent) {
    const g = this.gestures.get(e.pointerId)
    if (!g || g.kind === 'native') return
    e.preventDefault()
    const x = e.clientX, y = e.clientY
    switch (g.kind) {
      case 'joy': this.onJoyMove(x, y, performance.now()); break
      case 'skill': if (this.aim && this.aim.id === e.pointerId) this.onAimMove(x, y); break
      case 'ui': g.moved = Math.max(g.moved, Math.hypot(x - g.x0, y - g.y0)); break
      case 'world': g.moved = Math.max(g.moved, Math.hypot(x - g.x0, y - g.y0)); break
      case 'pan': {
        const [ax, az] = this.host.ren.screenToGround(g.lx, g.ly)
        const [bx, bz] = this.host.ren.screenToGround(x, y)
        this.host.ren.pan(ax - bx, az - bz)
        g.lx = x; g.ly = y
        break
      }
    }
  }

  private onEnd(e: { pointerId: number; clientX?: number; clientY?: number }, cancelled: boolean) {
    const id = e.pointerId
    const g = this.gestures.get(id)
    if (!g) return
    this.gestures.delete(id)
    const now = performance.now()
    switch (g.kind) {
      case 'joy': this.endJoy(); break
      case 'atk': this.endAtk(now, cancelled); break
      case 'skill':
        g.slot.classList.remove('press')
        if (this.aim && this.aim.id === id) this.endAim(cancelled)
        break
      case 'world':
        if (!cancelled && now - g.t0 < TL.TAP_MS && g.moved < TL.TAP_SLOP * this.s) this.worldTap(g.x0, g.y0)
        break
      case 'ui':
        // no native click comes for a tap that overlapped another finger, nor for a long press: fire it ourselves
        // (a trusted click that does arrive for this sequence is dropped by the capture-phase dedupe)
        if (!cancelled && g.moved < TL.TAP_SLOP * this.s && (g.multi || now - g.t0 >= UI_LONG_MS)) {
          this.uiFired = { el: g.el, t: now }
          g.el.click()
        }
        break
    }
  }

  cancelAll() {
    for (const id of [...this.gestures.keys()]) this.onEnd({ pointerId: id }, true)
    this.gestures.clear()
    if (this.aim) this.endAim(true)
    this.aim = null
    if (this.atk) {
      this.atk.btn?.classList.remove('press')
      this.stopChase(this.atk)
    }
    this.atk = null
    this.queued = null
    if (this.joy) this.endJoy()
    this.lookHeld = false
  }

  /** Android back while playing: cancels an aim first */
  handleBack(): boolean {
    if (this.aim) { this.endAim(true); return true }
    return false
  }

  // ------------------------------------------------------------------ joystick
  private inJoyZone(x: number, y: number) {
    return x >= this.ins.l + TL.JOY_EDGE * this.s && x < TL.JOY_ZONE_X * this.vw && y > TL.JOY_ZONE_Y * this.vh
  }

  private startJoy(id: number, x: number, y: number, now: number) {
    const s = this.s
    let bx = this.rest.x, by = this.rest.y, ox = 0, oy = 0
    if (settings.joyMode !== 'fixed') {
      // the drag is measured from the touch point (a resting thumb never moves the champion);
      // only the drawn ring is kept fully on screen
      bx = x; by = y
      ox = Math.min(Math.max(x, this.ins.l + TL.JR * s + 4), TL.JOY_ZONE_X * this.vw - TL.JR * s) - x
      oy = Math.min(Math.max(y, TL.JOY_ZONE_Y * this.vh + (TL.JR * s) / 2), this.vh - this.ins.b - TL.JR * s + 10) - y
    }
    this.joy = { id, bx, by, ox, oy, active: false, ux: 0, uz: 0, lastIssue: -1e9, lastAng: NaN, moved: false, stopped: true }
    this.joyEl.classList.add('on')
    this.onJoyMove(x, y, now)
  }

  private onJoyMove(x: number, y: number, now: number) {
    const j = this.joy
    if (!j) return
    const s = this.s
    let dx = x - j.bx, dy = y - j.by
    let d = Math.hypot(dx, dy)
    if (settings.joyMode !== 'fixed' && d > TL.JOY_FOLLOW * s) {
      const k = (d - TL.JOY_FOLLOW * s) / d
      j.bx += dx * k; j.by += dy * k
      dx = x - j.bx; dy = y - j.by
      d = Math.hypot(dx, dy)
    }
    j.active = d >= TL.JOY_DEAD * s
    if (j.active) {
      const u = TL.screenVecToWorldDir(dx, dy)
      if (u) { j.ux = u[0]; j.uz = u[1] }
    }
    const kr = Math.min(1, (TL.JR * s) / Math.max(1e-6, d))
    this.drawJoy(j.bx + j.ox, j.by + j.oy, j.bx + j.ox + dx * kr, j.by + j.oy + dy * kr, true)
    if (j.active) {
      const ang = Math.atan2(j.ux, j.uz)
      let da = Math.abs(ang - j.lastAng)
      if (da > Math.PI) da = Math.PI * 2 - da
      if ((Number.isNaN(j.lastAng) || da > TL.JOY_REISSUE_ANG) && now - j.lastIssue >= TL.JOY_MIN_GAP_MS) this.issueMove(now)
    }
  }

  private updateJoy(now: number) {
    const j = this.joy
    if (!j) return
    const me = this.w.me
    if (!me) return
    if (j.active) {
      if (now - j.lastIssue >= TL.JOY_REISSUE_MS) this.issueMove(now)
    } else if (j.moved && !j.stopped) {
      if (me.order?.t === 'move') me.cmdStop()
      j.stopped = true
    }
  }

  private issueMove(now: number) {
    const j = this.joy
    const me = this.w.me
    if (!j || !me) return
    if (me.dead) return
    // gated calls do not count as an issue: the move goes out on the first frame the gates open
    if (me.windup > 0 && this.atkProtect(now)) return
    if (this.attackOwnsMovement(now)) return
    if (me.order?.t === 'cast' && now - this.castOrderAt < TL.CAST_YIELD_MS) return
    j.lastIssue = now
    j.lastAng = Math.atan2(j.ux, j.uz)
    const p = TL.joyTarget(this.w, me, j.ux, j.uz)
    if (!p) { if (me.order?.t === 'move') me.cmdStop(); return }
    const o = me.order
    if (o && o.t === 'move' && dist(o.x, o.z, p[0], p[1]) < 0.15) return
    me.cmdMove(p[0], p[1])
    j.moved = true
    j.stopped = false
  }

  private endJoy() {
    const me = this.w.me
    if (me && me.order?.t === 'move' && this.joy?.moved) me.cmdStop()
    this.joy = null
    this.joyEl.classList.remove('on')
    this.drawJoy(this.rest.x, this.rest.y, this.rest.x, this.rest.y, false)
  }

  private drawJoy(bx: number, by: number, kx: number, ky: number, _on: boolean) {
    const s = this.s
    const R = 58 * s
    this.joyEl.style.transform = `translate(${bx - R}px, ${by - R}px)`
    this.joyKnob.style.transform = `translate(${kx - bx}px, ${ky - by}px)`
  }

  /** joystick direction in world space, or null when idle */
  joyDir(): [number, number] | null {
    return this.joy?.active ? [this.joy.ux, this.joy.uz] : null
  }

  // ------------------------------------------------------------------ attack
  private startAtk(mode: TL.AtkMode, btn: HTMLElement, now: number) {
    btn.classList.add('press')
    // a chase started by an earlier ⚔ gesture stays ours to leash
    const prev = this.atk
    this.atk = { mode, held: true, target: null, nextEval: 0, pulseUntil: 0, t0: now, lastIssue: -1e9, lastId: prev?.lastId ?? null, btn }
    this.updateAtk(now)
    if (!this.atk?.target) this.rangeFlashUntil = now + 400
  }

  private endAtk(now: number, cancelled: boolean) {
    const a = this.atk
    if (!a) return
    a.btn?.classList.remove('press')
    a.held = false
    // cancelled (pointercancel, panel opened, app hidden…): stop the chase this gesture started
    if (cancelled) { this.stopChase(a); this.atk = null; return }
    if (now - a.t0 < 200) a.pulseUntil = now + TL.TAP_PULSE_MS
  }

  /** the unit this attack gesture's order is still chasing, if any */
  private chased(a: AtkState): Unit | null {
    const o = this.w.me?.order
    return a.lastId && o && o.t === 'attack' && !o.auto && o.id === a.lastId ? this.w.unit(o.id) ?? null : null
  }

  /** stop a chase this gesture started — but never interrupt a fight that is already in range */
  private stopChase(a: AtkState) {
    const c = this.chased(a)
    const me = this.w.me
    if (c && me && !me.inAtkRange(c)) me.cmdStop()
  }

  private leashed(me: Champion, t: Unit, mode: TL.AtkMode) {
    const slack = TL.ACQ_SLACK[mode === 'tower' ? 'tower' : me.def.melee ? 'melee' : 'ranged']
    return TL.edgeDist(me, t) > TL.atkReach(me) + slack + TL.LEASH_EXTRA
  }

  /** an attack order can actually start swinging (not stunned, not spinning…) */
  private canSwing() {
    const me = this.w.me!
    return me.canAttack() && !me.hasBuff('spin')
  }

  private updateAtk(now: number) {
    const a = this.atk
    const me = this.w.me
    if (!a || !me) return
    if (!a.held && now >= a.pulseUntil) { this.leash(now); return }
    if (now >= a.nextEval || !a.target || !me.validTarget(a.target)) {
      a.nextEval = now + TL.ATK_EVAL_MS
      a.target = TL.pickAttackTarget(this.w, me, a.mode, a.target && me.validTarget(a.target) ? a.target : null, { joy: !!this.joy?.active, pri: settings.atkPri, focus: this.focus })
    }
    const t = a.target
    if (!t) {
      // the pick dropped a fleeing target while held: leash the chase we started
      const c = this.chased(a)
      if (c && this.leashed(me, c, a.mode)) me.cmdStop()
      return
    }
    // a skill cast after this press is walking into range: let it finish (a ⚔ press after the cast overrides it)
    if (me.order?.t === 'cast' && this.castOrderAt >= a.t0) return
    if (this.joy?.active) {
      // orb-walk: only commit to an attack when it can fire right now
      if (me.inAtkRange(t, 0.1) && me.atkCd <= 0.05 && me.windup <= 0 && !me.casting && this.canSwing()) { me.cmdAttack(t); a.lastIssue = now; a.lastId = t.id }
    } else {
      const o = me.order
      if (!(o && o.t === 'attack' && o.id === t.id && !o.auto)) { me.cmdAttack(t); a.lastIssue = now }
      a.lastId = t.id // issued or adopted: this gesture now owns (and leashes) the chase
    }
  }

  /** released ⚔: keep the chase we own on a leash until it ends */
  private leash(now: number) {
    const a = this.atk
    const me = this.w.me
    if (!a || !me) return
    const c = this.joy?.active ? null : this.chased(a)
    if (!c) { if (now >= a.pulseUntil) this.atk = null; return }
    if (this.leashed(me, c, a.mode)) { me.cmdStop(); this.atk = null }
  }

  private atkProtect(now: number) {
    const a = this.atk
    return !!a && (a.held || now < a.pulseUntil || now - a.lastIssue < TL.ATK_PROTECT_MS)
  }

  private attackOwnsMovement(now: number) {
    const a = this.atk
    const me = this.w.me
    if (!a || !me || !a.target) return false
    if (!(a.held || now < a.pulseUntil)) return false
    const o = me.order
    if (!o || o.t !== 'attack') return false
    return me.windup > 0 || (me.atkCd <= 0.05 && me.inAtkRange(a.target, 0.1) && this.canSwing())
  }

  showAtkRange() {
    return !!this.atk?.held || performance.now() < this.rangeFlashUntil
  }

  // ------------------------------------------------------------------ skills
  private fwd(): [number, number] {
    const me = this.w.me!
    return this.joyDir() ?? TL.facingDir(me)
  }

  private startSkill(id: number, key: CastKey, slot: HTMLElement, x: number, y: number, now: number) {
    const me = this.w.me
    if (!me) return
    const def = me.castDef(key)
    if (!def) { this.gestures.set(id, { kind: 'inert' }); return }
    const r = me.canUse(key)
    if (INERT_CAST.includes(r) || (r === 'cooldown' && (me.cds[key] ?? 0) > TL.PRE_AIM_CD)) {
      this.host.castErr(r)
      navigator.vibrate?.(10)
      this.gestures.set(id, { kind: 'inert' })
      return
    }
    slot.classList.add('press')
    if (def.target === 'self' && def.ind.t === 'none') {
      this.fire(key, { x: me.x, z: me.z, reach: 0 }, now)
      return
    }
    if (this.aim) return
    this.aim = { id, key, def, ox: x, oy: y, dx: 0, dy: 0, overCancel: false }
    const R = TL.AIM_MAX * this.s
    this.aimEl.style.setProperty('--ar', R + 'px')
    this.aimEl.style.transform = `translate(${x - R}px, ${y - R}px)`
    this.aimKnob.style.transform = 'translate(0px, 0px)'
    this.aimEl.classList.add('on')
    this.cancelEl.classList.add('show')
    this.cancelEl.classList.remove('hot')
    this.host.root.classList.add('aiming')
    // measure now that it is laid out
    const cr = this.cancelEl.getBoundingClientRect()
    if (cr.width) this.cancelC = { x: cr.left + cr.width / 2, y: cr.top + cr.height / 2 }
  }

  private onAimMove(x: number, y: number) {
    const a = this.aim
    if (!a) return
    a.dx = x - a.ox
    a.dy = y - a.oy
    a.overCancel = Math.hypot(x - this.cancelC.x, y - this.cancelC.y) <= TL.CANCEL_R_HIT * this.s
    this.cancelEl.classList.toggle('hot', a.overCancel)
    const d = Math.hypot(a.dx, a.dy)
    const k = Math.min(1, (TL.AIM_MAX * this.s) / Math.max(1e-6, d))
    this.aimKnob.style.transform = `translate(${a.dx * k}px, ${a.dy * k}px)`
  }

  private resolve(a: AimState): TL.CastPlan | null {
    const me = this.w.me
    if (!me) return null
    return TL.aimCastPlan(this.w, me, a.key, a.def, a.dx, a.dy, this.s, this.fwd(), settings.atkPri)
  }

  private endAim(cancelled: boolean) {
    const a = this.aim
    this.aim = null
    this.aimTarget = null
    this.aimEl.classList.remove('on')
    this.cancelEl.classList.remove('show', 'hot')
    this.host.root.classList.remove('aiming')
    if (!a) return
    if (cancelled || a.overCancel) { sfx.play('click'); return }
    const p = this.resolve(a)
    if (!p) { this.host.castErr('notarget'); return }
    this.fire(a.key, p, performance.now())
  }

  private fire(key: CastKey, p: TL.CastPlan, now: number) {
    const me = this.w.me
    if (!me) return
    const r = this.host.doCast(key, p.x, p.z, p.tid, true)
    if (r === 'ok') { navigator.vibrate?.(8); this.kickJoy() }
    else if (r === 'moving') this.castOrderAt = now
    else if (r === 'busy' || (r === 'cooldown' && (me.cds[key] ?? 0) <= 0.35)) {
      this.queued = { key, rx: p.x - me.x, rz: p.z - me.z, tid: p.tid, until: now + TL.RETRY_MS }
    } else this.host.castErr(r)
  }

  /** re-issue the joystick move on the next frame (the cast may have moved or stopped us) */
  private kickJoy() {
    if (this.joy) { this.joy.lastIssue = -1e9; this.joy.lastAng = NaN }
  }

  /** hardware keyboard in touch mode (tablets): no cursor, so smart-cast like a tap */
  keyCast(key: CastKey) {
    const me = this.w.me
    if (!me || me.dead) return
    const def = me.castDef(key)
    if (!def) return
    const r = me.canUse(key)
    if (INERT_CAST.includes(r)) { this.host.castErr(r); return }
    const p = TL.smartCastPlan(this.w, me, key, def, this.fwd(), settings.atkPri)
    if (!p) { this.host.castErr('notarget'); return }
    this.fire(key, p, performance.now())
  }

  private retryQueued(now: number) {
    const q = this.queued
    const me = this.w.me
    if (!q || !me) return
    if (now > q.until) { this.queued = null; return }
    if (me.canUse(q.key) === 'ok') {
      this.queued = null
      const r = this.host.doCast(q.key, me.x + q.rx, me.z + q.rz, q.tid, true)
      if (r === 'moving') this.castOrderAt = now
      else if (r === 'ok') this.kickJoy()
    }
  }

  // ------------------------------------------------------------------ world taps / focus
  private worldTap(x: number, y: number) {
    const me = this.w.me
    if (!me) return
    const u = this.host.ren.pickUnit(x, y, v => v !== me && me.validTarget(v), TL.PICK_MIN_RAD * this.s)
    if (u) {
      this.focus = u
      this.w.fx({ kind: 'ring', x: u.x, z: u.z, r: u.radius + 0.6, color: 0xff4040, dur: 0.35 })
    } else this.focus = null
  }

  // ------------------------------------------------------------------ per frame
  update(now: number) {
    const me = this.w.me
    if (!me) return
    if (me.dead) {
      if (this.aim) this.endAim(true)
      if (this.atk?.btn) this.atk.btn.classList.remove('press')
      this.atk = null
      this.queued = null
    }
    if (this.focus && (!me.validTarget(this.focus) || dist(me.x, me.z, this.focus.x, this.focus.z) > TL.FOCUS_MAX)) this.focus = null
    this.updateAtk(now)
    this.updateJoy(now)
    this.retryQueued(now)
    if (this.dbg) this.drawDebug()
  }

  /** skill indicator while aiming */
  indicator(): IndicatorSpec | null {
    const a = this.aim
    const me = this.w.me
    if (!a || !me) { this.aimTarget = null; return null }
    const p = this.resolve(a)
    this.aimTarget = p?.tid ? this.w.unit(p.tid) : null
    const col = a.overCancel ? 0x8a8a8a : p?.tid ? 0xff6a4a : undefined
    return this.host.specFor(a.def, p?.x ?? me.x, p?.z ?? me.z, col)
  }

  /** camera lead while aiming long-range skills */
  camLead(): { x: number; z: number } {
    const a = this.aim
    const me = this.w.me
    if (!settings.aimCam || !a || !me || Math.hypot(a.dx, a.dy) < TL.AIM_DEAD * this.s) return { x: 0, z: 0 }
    const p = this.resolve(a)
    if (!p) return { x: 0, z: 0 }
    const reach = dist(me.x, me.z, p.x, p.z)
    if (reach < 1e-3) return { x: 0, z: 0 }
    const ux = (p.x - me.x) / reach, uz = (p.z - me.z) / reach
    const visR = 7 + 5 * Math.max(0, -uz) - Math.max(0, uz)
    const k = Math.min(12, Math.max(0, reach - visR))
    return { x: ux * k, z: uz * k }
  }

  hoverTarget(): Unit | null {
    return this.aimTarget ?? this.atk?.target ?? this.focus
  }

  private drawDebug() {
    const d = this.dbg!
    const g = [...this.gestures.entries()].map(([id, x]) => `${id}:${x.kind}`).join(' ')
    const me = this.w.me
    d.textContent = `gestures ${g || '-'} | joy ${this.joy ? (this.joy.active ? 'on' : 'neutral') : '-'} | aim ${this.aim?.key ?? '-'} | atk ${this.atk ? (this.atk.held ? 'held' : 'pulse') + ':' + (this.atk.target?.id ?? '-') : '-'} | order ${me?.order?.t ?? '-'} | s ${this.s.toFixed(2)}`
  }

  destroy() {
    this.cancelAll()
    for (const f of this.off) f()
    this.dbg?.remove()
  }
}
