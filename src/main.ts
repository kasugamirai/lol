import './styles.css'
import { loadIdentity, identity, roomProof, Identity } from './nostr/identity'
import { fetchMyStats, localStats, PlayerStats } from './nostr/store'
import { Lobby, MMMode, MMOffer, MM_MODES } from './net/lobby'
import { MatchRoom, slotTeam } from './net/room'
import { RoomScreen } from './ui/roomscreen'
import { GameScreen } from './ui/game'
import { MenuScreen, RoomsScreen, ProfileScreen, practiceModal } from './ui/screens'
import { el, esc, toast, fmtTime, closeTopModal, confirmModal, MODAL_OPEN_EVENT } from './ui/dom'
import { settings, saveSettings } from './settings'
import { initDevice, isTouchDevice, mobileActive, applyDeviceClasses, unlockOrientation, requestFullscreen } from './ui/device'
import { sfx } from './audio'
import type { MapId } from './game/mapdef'
import { randId } from './util/math'

interface Screen { el: HTMLElement; destroy(): void }

export class App {
  id: Identity
  stats: PlayerStats | null = localStats()
  lobby: Lobby
  room: MatchRoom | null = null
  private screen: Screen | null = null
  private mmBox: HTMLDivElement | null = null
  private mmMode: MMMode | null = null
  private mmTimer = 0
  /** a sentinel history entry is on top (mobile back-button handling) */
  backArmed = false
  private adTimer = 0
  private statsCbs = new Set<() => void>()

  constructor() {
    // reload / restored tab: we are already standing on our sentinel entry, do not stack another one
    this.backArmed = mobileActive() && history.state?.nr === 1
    const { id, created } = loadIdentity()
    this.id = id
    if (created) setTimeout(() => toast(`已为你自动创建 Nostr 账户：${id.name}`, 'ok', 4000), 400)
    this.lobby = new Lobby({ pk: id.pk, name: id.name })
    this.lobby.onMatched = (o, owner) => this.onMatched(o, owner)
    this.refreshStats()
    sfx.setVolume(settings.volume)
    // resume audio on the next real user activation (touch pointerdown does not count)
    sfx.armUnlock()
    this.adTimer = window.setInterval(() => this.advertise(), 3000)
    const qs = new URLSearchParams(location.search)
    const roomParam = qs.get('room')
    const practice = qs.get('practice')
    if (roomParam) this.joinRoom(roomParam.replace(/[^a-z0-9]/gi, ''))
    else if (practice) {
      if (qs.get('champ')) settings.lastChamp = qs.get('champ')!
      this.createRoom({ name: '人机练习', map: practice === 'aram' ? 'aram' : 'rift', teamSize: Number(qs.get('size') ?? 5), botDiff: Number(qs.get('diff') ?? 1), priv: true, fill: true, autostart: true })
    } else this.showMenu()
  }

  get me() { return { pk: this.id.pk, name: this.id.name } }

  onStats(cb: () => void) { this.statsCbs.add(cb); return () => this.statsCbs.delete(cb) }
  refreshStats() {
    fetchMyStats().then(s => { this.stats = s; for (const cb of this.statsCbs) cb() }).catch(() => {})
  }
  identityChanged() {
    this.id = identity()
    this.lobby.setName(this.id.name)
    this.stats = localStats()
    this.refreshStats()
  }

  private setScreen(s: Screen | null) {
    const prev = this.screen
    prev?.destroy()
    this.screen = s
    document.body.classList.toggle('in-game', s instanceof GameScreen)
    if (prev instanceof GameScreen && !(s instanceof GameScreen)) {
      unlockOrientation()
      // apply a mode change that was deferred while the match was running
      applyDeviceClasses()
    }
    this.armBack()
    this.renderMM()
  }

  /** mobile: keep one sentinel history entry on top so the back button stays inside the app */
  armBack() {
    if (this.backArmed || !mobileActive()) return
    history.pushState({ nr: 1 }, '')
    this.backArmed = true
  }

  /** back button / gesture: true if handled (the sentinel is then re-armed), false to let the browser leave */
  handleBack(): boolean {
    if (closeTopModal()) return true
    const s = this.screen
    if (s instanceof GameScreen) {
      ;(s as any).handleBack?.()
      return true
    }
    if (s instanceof RoomScreen) {
      if (!s.handleBack()) {
        confirmModal('离开房间？', '离开房间', true).then(ok => { if (ok && this.screen === s) this.leaveRoom(true) })
      }
      return true
    }
    if (s instanceof RoomsScreen || s instanceof ProfileScreen) { this.showMenu(); return true }
    if (s instanceof MenuScreen || !s) return false
    // loading screen: stay put, the pending join/create resolves on its own
    return true
  }

  showMenu() { this.setScreen(new MenuScreen(this)) }
  showRooms() { this.setScreen(new RoomsScreen(this)) }
  showProfile(tab: 'stats' | 'board' | 'account' = 'stats') { this.setScreen(new ProfileScreen(this, tab)) }
  practice() { practiceModal(this) }

  // ------------------------------------------------------------------ rooms
  async createRoom(o: { name: string; map: MapId; teamSize: number; botDiff: number; priv?: boolean; fill?: boolean; autostart?: boolean; mm?: MMOffer }) {
    this.leaveRoom(false)
    const id = o.mm?.room ?? MatchRoom.newId()
    const room = new MatchRoom(id)
    this.room = room
    this.setPresence(room)
    this.loading('正在创建房间…')
    await room.whenSyncedOrTimeout()
    room.create({
      id, name: o.name, map: o.map, teamSize: o.teamSize, owner: this.id.pk, ownerName: this.id.name, botDiff: o.botDiff,
      priv: !!o.priv, mm: !!o.mm, quick: !!o.mm?.quick, expected: o.mm?.players.map(p => p.pk),
    })
    const auth = await roomProof(id)
    if (o.mm) {
      // pre-assign matched players
      const counts = [0, 0]
      room.yr.doc.transact(() => {
        for (const p of o.mm!.players) {
          const k = (p.team === 0 ? 'b' : 'r') + counts[p.team]++
          room.slots.set(k, { kind: 'human', pk: p.pk, name: p.name, champ: p.pk === this.id.pk ? settings.lastChamp : null, spells: ['flash', 'heal'], ready: false, auth: p.pk === this.id.pk ? auth : undefined })
        }
      })
      room.say({ n: '系统', pk: '', t: '匹配成功！30 秒内选择英雄，空位将由电脑补齐。', tm: -1, sys: true })
    } else {
      room.claim('b0', { ...this.me, auth }, { champ: settings.lastChamp, spells: settings.spells })
    }
    if (o.fill) room.fillBots(o.botDiff)
    // "start now" with nobody else queued: go straight into the game
    if (o.mm?.quick && o.mm.players.length === 1) {
      room.fillBots(o.botDiff)
      o.autostart = true
    }
    if (o.autostart) {
      room.start()
      this.startGame(room)
      return
    }
    this.showRoom(room)
  }

  async joinRoom(id: string) {
    if (this.room?.id === id) { this.showRoom(this.room); return }
    this.leaveRoom(false)
    const room = new MatchRoom(id)
    this.room = room
    this.setPresence(room)
    this.loading('正在进入房间 ' + id + ' …')
    const ok = await room.whenSyncedOrTimeout(6000)
    if (this.room !== room) return
    const info = room.info
    if (!info) {
      toast(ok ? '房间不存在或已解散' : '无法连接到房间（中继服务器无响应）', 'err')
      this.leaveRoom(true)
      return
    }
    const mine = room.slotOf(this.id.pk)
    if (info.status === 'playing') {
      if (mine) toast('重新连接到进行中的对局…', 'info')
      else toast('对局进行中，你将以观战者身份进入', 'info')
      this.startGame(room)
      return
    }
    if (!mine) {
      const k = room.freeSlot()
      const auth = await roomProof(id)
      if (k) room.claim(k, { ...this.me, auth }, { champ: settings.lastChamp, spells: settings.spells })
      else toast('房间已满，你将观战', 'info')
    }
    room.say({ n: '系统', pk: '', t: `${this.id.name} 加入了房间`, tm: -1, sys: true })
    this.showRoom(room)
  }

  private setPresence(room: MatchRoom) {
    room.yr.awareness.setLocalState({ pk: this.id.pk, name: this.id.name, inGame: false })
  }

  showRoom(room: MatchRoom) {
    this.setScreen(new RoomScreen({
      me: this.me,
      leaveRoom: () => this.leaveRoom(true),
      startGame: r => this.startGame(r),
    }, room))
  }

  startGame(room: MatchRoom) {
    const slot = room.slotOf(this.id.pk)
    this.setScreen(new GameScreen({
      room, me: this.me, slot,
      onExit: toRoom => {
        this.refreshStats()
        if (toRoom && this.room === room) {
          const info = room.info
          if (info && info.status !== 'lobby' && info.owner === this.id.pk) room.backToLobby()
          this.setPresence(room)
          this.showRoom(room)
        } else this.leaveRoom(true)
      },
    }))
  }

  leaveRoom(toMenu: boolean) {
    const r = this.room
    if (r) {
      const info = r.info
      if (info && info.status === 'lobby') {
        r.leaveSlot(this.id.pk)
        r.say({ n: '系统', pk: '', t: `${this.id.name} 离开了房间`, tm: -1, sys: true })
      }
      // hand over ownership
      if (info && info.owner === this.id.pk) {
        const online = r.onlinePks()
        const next = r.entries().find(([, s]) => s.kind === 'human' && s.pk && s.pk !== this.id.pk && online.has(s.pk))
        if (next) r.setMeta({ owner: next[1].pk!, ownerName: next[1].name })
      }
      this.room = null
      setTimeout(() => r.destroy(), 300)
      this.lobby.advertise(null)
    }
    if (new URLSearchParams(location.search).get('room')) history.replaceState(null, '', location.pathname + (location.search.includes('id=') ? '?id=' + new URLSearchParams(location.search).get('id') : ''))
    if (toMenu) this.showMenu()
  }

  private loading(text: string) {
    const s = { el: el('div', 'screen loading-screen', `<div class="spinner"></div><div>${esc(text)}</div>`), destroy() { this.el.remove() } }
    document.getElementById('app')!.appendChild(s.el)
    this.setScreen(s)
  }

  private advertise() {
    const r = this.room
    const info = r?.info
    if (!r || !info || info.priv || info.mm || info.owner !== this.id.pk) { if (this.lobby.ticket === null) this.lobby.advertise(null); return }
    this.lobby.advertise({
      id: info.id, name: info.name, map: info.map, teamSize: info.teamSize,
      humans: r.entries().filter(([, s]) => s.kind === 'human').length,
      status: info.status, ownerName: info.ownerName, since: info.createdAt,
    })
  }

  // ------------------------------------------------------------------ matchmaking
  quickMatch(mode: MMMode) {
    if (this.room) this.leaveRoom(false)
    this.lobby.queue(mode, this.stats?.rating ?? 1000)
    toast(`开始匹配：${MM_MODES[mode].label}`, 'info')
    this.renderMM()
    clearInterval(this.mmTimer)
    this.mmTimer = window.setInterval(() => this.renderMM(), 500)
  }
  cancelMatch() {
    this.lobby.cancelQueue()
    clearInterval(this.mmTimer)
    this.renderMM()
  }

  private onMatched(o: MMOffer, asOwner: boolean) {
    clearInterval(this.mmTimer)
    this.renderMM()
    sfx.unlock()
    sfx.play('matchfound')
    toast('⚔️ 找到对局！', 'ok')
    const cfg = MM_MODES[o.mode]
    if (asOwner) this.createRoom({ name: `匹配 · ${cfg.label}`, map: cfg.map, teamSize: cfg.teamSize, botDiff: 1, mm: o })
    else setTimeout(() => this.joinRoom(o.room), 900)
  }

  private renderMM() {
    const t = this.lobby.ticket
    const inGame = this.screen instanceof GameScreen
    if (!t || inGame) { this.mmBox?.remove(); this.mmBox = null; this.mmMode = null; return }
    if (!this.mmBox) {
      this.mmBox = el('div', 'mm-box')
      document.body.appendChild(this.mmBox)
      this.mmBox.addEventListener('click', e => {
        const t = e.target as HTMLElement
        if (t.closest('[data-mm=cancel]')) this.cancelMatch()
        else if (t.closest('[data-mm=now]')) this.lobby.startNow()
      })
    }
    // build the skeleton once per mode; the 500 ms refresh only updates text so taps on the buttons are never lost
    if (this.mmMode !== t.mode) {
      this.mmMode = t.mode
      this.mmBox.innerHTML = `<div class="mm-spin"></div><div><b>正在匹配 · ${esc(MM_MODES[t.mode].label)}</b><div class="mm-sub"><span class="mm-time"></span> · 队列中 <span class="mm-count"></span> 人 · 在线 <span class="mm-online"></span> 人<span class="mm-hint"><br><span class="mm-hint-t"></span></span></div></div>
      <div class="mm-btns"><button class="btn-gold" data-mm="now">立即开始</button><button class="btn" data-mm="cancel">取消</button></div>`
    }
    const n = this.lobby.queueCount(t.mode)
    const set = (sel: string, v: string) => { const e = this.mmBox!.querySelector(sel); if (e && e.textContent !== v) e.textContent = v }
    set('.mm-time', fmtTime((Date.now() - t.since) / 1000))
    set('.mm-count', String(n))
    set('.mm-online', String(this.lobby.online()))
    set('.mm-hint-t', n < 2 ? '等待更多玩家加入… 或点击「立即开始」由电脑补位' : '「立即开始」将与当前队列中的玩家开局')
  }
}

const LS_HINT = 'nexusrift.mobileHint'

function boot() {
  initDevice()
  // one-time low-quality default on phones/tablets (hardware check, not the UI mode); the user can raise it later
  if (isTouchDevice() && !settings.mobilePerfInit) {
    settings.quality = 0
    settings.shadows = false
    settings.mobilePerfInit = true
    saveSettings()
  }
  const app = new App()
  ;(window as any).__app = app
  bindGlobal(app)
  if (mobileActive()) {
    let seen = true
    try { seen = !!localStorage.getItem(LS_HINT); localStorage.setItem(LS_HINT, '1') } catch { /* private mode */ }
    if (!seen) setTimeout(() => toast('横屏游玩体验更佳 · 可「添加到主屏幕」获得全屏体验', 'info', 5000), 1200)
  }
}

/** page-level listeners: audio re-arm, iOS touch quirks, back button, rotate gate */
function bindGlobal(app: App) {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sfx.armUnlock() })
  // iOS only applies :active styles when a touchstart listener exists
  document.addEventListener('touchstart', () => {}, { passive: true })
  // iOS Safari ignores user-scalable=no for pinch; macOS Safari fires this for trackpad pinch too, so gate it
  document.addEventListener('gesturestart', e => { if (mobileActive()) e.preventDefault() })
  // iOS leaves the fixed layout scrolled after the keyboard closes
  document.addEventListener('focusout', () => {
    if (!document.body.classList.contains('mobile')) return
    setTimeout(() => {
      const a = document.activeElement
      if (!(a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement)) window.scrollTo(0, 0)
    }, 60)
  })
  window.addEventListener('popstate', () => {
    if (!app.backArmed) return
    app.backArmed = false
    // leaving a room strips ?room= from the sentinel; keep the entry we land on clean too
    const q = new URLSearchParams(location.search)
    if (!app.room && q.has('room')) {
      q.delete('room')
      const qs = q.toString()
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''))
    }
    if (app.handleBack()) app.armBack()
  })
  app.armBack()
  // after the menu consumed a back press, a newly opened modal re-arms it so back closes the modal
  document.addEventListener(MODAL_OPEN_EVENT, () => app.armBack())
  document.querySelector('.rotate-gate')?.addEventListener('click', () => requestFullscreen())
}

boot()
export const unused = { slotTeam, randId }
