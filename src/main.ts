import './styles.css'
import { loadIdentity, identity, roomProof, Identity } from './nostr/identity'
import { fetchMyStats, localStats, PlayerStats } from './nostr/store'
import { Lobby, MMMode, MMOffer, MM_MODES } from './net/lobby'
import { MatchRoom, slotTeam } from './net/room'
import { RoomScreen } from './ui/roomscreen'
import { GameScreen } from './ui/game'
import { MenuScreen, RoomsScreen, ProfileScreen, practiceModal } from './ui/screens'
import { el, esc, toast, fmtTime } from './ui/dom'
import { settings } from './settings'
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
  private mmTimer = 0
  private adTimer = 0
  private statsCbs = new Set<() => void>()

  constructor() {
    const { id, created } = loadIdentity()
    this.id = id
    if (created) setTimeout(() => toast(`已为你自动创建 Nostr 账户：${id.name}`, 'ok', 4000), 400)
    this.lobby = new Lobby({ pk: id.pk, name: id.name })
    this.lobby.onMatched = (o, owner) => this.onMatched(o, owner)
    this.refreshStats()
    sfx.setVolume(settings.volume)
    window.addEventListener('pointerdown', () => sfx.unlock(), { once: true })
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
    this.screen?.destroy()
    this.screen = s
    document.body.classList.toggle('in-game', s instanceof GameScreen)
    this.renderMM()
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
      priv: !!o.priv, mm: !!o.mm, expected: o.mm?.players.map(p => p.pk),
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
    if (!t || inGame) { this.mmBox?.remove(); this.mmBox = null; return }
    if (!this.mmBox) {
      this.mmBox = el('div', 'mm-box')
      document.body.appendChild(this.mmBox)
      this.mmBox.addEventListener('click', e => { if ((e.target as HTMLElement).closest('[data-mm=cancel]')) this.cancelMatch() })
    }
    const secs = (Date.now() - t.since) / 1000
    const n = this.lobby.queueCount(t.mode)
    this.mmBox.innerHTML = `<div class="mm-spin"></div><div><b>正在匹配 · ${MM_MODES[t.mode].label}</b><div class="mm-sub">${fmtTime(secs)} · 队列中 ${n} 人 · 在线 ${this.lobby.online()} 人${n < 2 ? '<br>等待更多玩家加入…（也可以先进行人机练习）' : ''}</div></div><button class="btn" data-mm="cancel">取消</button>`
  }
}

function boot() {
  const app = new App()
  ;(window as any).__app = app
}

boot()
export const unused = { slotTeam, randId }
