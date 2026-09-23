import { MatchRoom, SlotInfo, slotKeys, slotTeam, ChatMsg } from '../net/room'
import { CHAMPIONS, CHAMP_MAP } from '../game/data/champions'
import { SPELLS, SPELL_MAP } from '../game/data/spells'
import { el, esc, onAct, toast, champColor, copyText } from './dom'
import { settings, saveSettings } from '../settings'
import { sfx } from '../audio'
import type { MapId } from '../game/mapdef'
import { mobileActive, requestFullscreen } from './device'

export interface RoomScreenHost {
  me: { pk: string; name: string; auth?: any }
  leaveRoom(): void
  startGame(room: MatchRoom): void
}

const DIFF = ['简单', '普通', '困难']
const MAPS: Record<MapId, string> = { rift: '召唤师峡谷（三路）', aram: '极地大乱斗（单路）' }

export class RoomScreen {
  readonly el: HTMLDivElement
  private off: (() => void)[] = []
  private chatSeen = 0
  private timer: number
  private absentSince = new Map<string, number>()
  private ownerAbsentSince = 0
  private countdownEnd = 0
  private detailChamp: string | null = null
  private started = false
  /** last html written to .rs-main (skip identical rewrites: they drop taps and close pickers) */
  private lastHtml = ''
  /** a <select> picker is (probably) open: defer re-renders until it closes */
  private selOpen = false
  private selAt = 0
  private dirty = false
  /** a pointer is down: a deferred re-render waits for its release so the tapped button survives until click */
  private ptrDown = false
  private renderOnUp = false
  /** champion shown in the detail pane at the last rewrite (its scroll position is kept only for the same champion) */
  private shownDetail = ''
  /** unread chat messages while the phone-landscape chat drawer is closed */
  private unread = 0
  private readonly plQuery = matchMedia('(max-height: 500px) and (orientation: landscape) and (min-width: 481px)')

  constructor(private host: RoomScreenHost, private room: MatchRoom) {
    this.el = el('div', 'screen room-screen')
    document.getElementById('app')!.appendChild(this.el)
    this.detailChamp = settings.lastChamp
    this.off.push(room.onChange(() => this.render()))
    const onChat = () => this.renderChat()
    room.chat.observe(onChat)
    this.off.push(() => room.chat.unobserve(onChat))
    this.off.push(onAct(this.el, {
      leave: () => this.host.leaveRoom(),
      slot: t => this.moveTo(t.dataset.k!),
      addbot: t => { this.room.addBot(t.dataset.k!, this.room.info?.botDiff ?? 1); sfx.play('click') },
      kick: t => this.room.removeSlot(t.dataset.k!),
      champ: t => this.pick(t.dataset.id!),
      ready: () => { requestFullscreen(); this.toggleReady() },
      start: () => { requestFullscreen(); this.start() },
      fill: () => { this.room.fillBots(this.room.info?.botDiff ?? 1); sfx.play('click') },
      copy: () => this.share(),
      send: () => this.send(),
      chat: () => this.toggleChat(),
      ownercfg: () => this.el.classList.toggle('owner-open'),
    }))
    this.el.addEventListener('change', e => {
      const t = e.target as HTMLSelectElement
      const info = this.room.info
      if (!info) return
      if (t.dataset.set === 'map') this.room.setMeta({ map: t.value as MapId })
      if (t.dataset.set === 'size') {
        const size = Number(t.value)
        this.room.yr.doc.transact(() => {
          this.room.meta.set('teamSize', size)
          for (const k of [...this.room.slots.keys()]) if (Number(k.slice(1)) >= size) this.room.slots.delete(k)
        })
        // make sure I still have a slot
        if (!this.room.slotOf(this.host.me.pk)) { const k = this.room.freeSlot(); if (k) this.room.claim(k, this.host.me) }
      }
      if (t.dataset.set === 'diff') {
        const d = Number(t.value)
        this.room.yr.doc.transact(() => {
          this.room.meta.set('botDiff', d)
          for (const [k, s] of this.room.slots.entries()) if (s.kind === 'bot') this.room.slots.set(k, { ...s, diff: d })
        })
      }
      if (t.dataset.set === 'sp0' || t.dataset.set === 'sp1') this.setSpell(Number(t.dataset.set.slice(2)), t.value)
      if (t instanceof HTMLSelectElement) this.pickerClosed()
    })
    // a teammate's update must not rebuild the DOM under an open native <select> picker.
    // The page gets no pointerdown while a native picker is open, so any other pointerdown means it closed.
    const onPtrDown = (e: PointerEvent) => {
      this.ptrDown = true
      if (e.target instanceof HTMLSelectElement && this.el.contains(e.target)) { this.selOpen = true; this.selAt = performance.now() }
      else if (this.selOpen) this.pickerClosed()
    }
    const onPtrUp = () => {
      this.ptrDown = false
      if (this.renderOnUp) { this.renderOnUp = false; setTimeout(() => this.render(), 0) }
    }
    document.addEventListener('pointerdown', onPtrDown, true)
    window.addEventListener('pointerup', onPtrUp, true)
    window.addEventListener('pointercancel', onPtrUp, true)
    this.off.push(() => {
      document.removeEventListener('pointerdown', onPtrDown, true)
      window.removeEventListener('pointerup', onPtrUp, true)
      window.removeEventListener('pointercancel', onPtrUp, true)
    })
    this.el.addEventListener('focusout', e => { if (e.target instanceof HTMLSelectElement) this.pickerClosed() })
    // leaving phone landscape: the chat is a plain strip again, drop the drawer state
    const onPl = () => { if (!this.plQuery.matches) { this.el.classList.remove('chat-open'); this.unread = 0; this.updateUnread() } }
    this.plQuery.addEventListener?.('change', onPl)
    this.off.push(() => this.plQuery.removeEventListener?.('change', onPl))
    this.el.addEventListener('keydown', e => {
      // IME: the Enter that commits a composition must not send a half-typed message
      if ((e.target as HTMLElement).classList.contains('rc-in') && e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) this.send()
    })
    this.el.innerHTML = `<div class="rs-main"></div><div class="room-chat"><div class="rc-log"></div><div class="rc-row"><input class="rc-in" maxlength="140" placeholder="${mobileActive() ? '聊天…' : '聊天…（Enter 发送）'}" enterkeyhint="send" autocomplete="off"><button class="btn" data-act="send">发送</button></div></div>`
    this.chatSeen = room.chat.length
    this.timer = window.setInterval(() => this.tick(), 1000)
    this.render()
    this.renderChat()
  }

  private get isOwner() { return this.room.info?.owner === this.host.me.pk }
  private get mySlot() { return this.room.slotOf(this.host.me.pk) }

  /** Android back: close the chat drawer if open; true if handled */
  handleBack(): boolean {
    // the drawer only exists in the phone-landscape layout
    if (!this.plQuery.matches || !this.el.classList.contains('chat-open')) return false
    this.toggleChat(false)
    return true
  }

  private toggleChat(open = !this.el.classList.contains('chat-open')) {
    this.el.classList.toggle('chat-open', open)
    if (open) {
      this.unread = 0
      this.updateUnread()
      ;(this.el.querySelector('.rc-in') as HTMLInputElement | null)?.focus()
    }
  }

  private updateUnread() {
    const p = this.el.querySelector('.rc-unread')
    if (!p) return
    p.textContent = String(this.unread)
    p.classList.toggle('hidden', !this.unread)
  }

  private share() {
    const url = location.origin + location.pathname + '?room=' + this.room.id
    if (typeof navigator.share === 'function' && mobileActive()) {
      navigator.share({ title: '星核峡谷 · ' + (this.room.info?.name ?? ''), url }).catch(() => {})
    } else copyText(url)
  }

  private pickerClosed() {
    this.selOpen = false
    if (!this.dirty) return
    this.dirty = false
    // rebuilding now would replace the button under a finger/cursor that is still down: wait for its release
    if (this.ptrDown) this.renderOnUp = true
    else setTimeout(() => this.render(), 0) // let focus settle first (focusout fires before activeElement moves)
  }

  /** a picker is (probably) still open: bounded, since dismissing one without a change fires nothing */
  private get pickerOpen() {
    const active = document.activeElement
    return this.selOpen && performance.now() - this.selAt < 8000 && active instanceof HTMLSelectElement && this.el.contains(active)
  }

  private moveTo(k: string) {
    const cur = this.room.slots.get(k)
    if (cur && cur.kind === 'human') return
    if (cur && cur.kind === 'bot' && !this.isOwner) return
    const mine = this.mySlot ? this.room.slots.get(this.mySlot) : undefined
    this.room.claim(k, this.host.me, mine)
    sfx.play('click')
  }

  private pick(id: string) {
    this.detailChamp = id
    const k = this.mySlot
    if (k) this.room.update(k, { champ: id })
    settings.lastChamp = id
    saveSettings()
    sfx.play('click')
    this.render()
  }

  private setSpell(i: number, id: string) {
    const k = this.mySlot
    if (!k) return
    const s = this.room.slots.get(k)!
    const sp = [...s.spells] as [string, string]
    sp[i] = id
    if (sp[0] === sp[1]) sp[1 - i] = SPELLS.find(x => x.id !== id)!.id
    this.room.update(k, { spells: sp })
    settings.spells = sp
    saveSettings()
  }

  private toggleReady() {
    const k = this.mySlot
    if (!k) return
    const s = this.room.slots.get(k)!
    if (!s.champ) { this.pick(settings.lastChamp || 'blaze') }
    this.room.update(k, { ready: !s.ready })
    sfx.play('click')
  }

  private start() {
    const info = this.room.info
    if (!info || !this.isOwner) return
    const entries = this.room.entries()
    if (!entries.length) return
    const online = this.room.onlinePks()
    // drop humans that are gone
    for (const [k, s] of entries) if (s.kind === 'human' && s.pk && !online.has(s.pk) && s.pk !== this.host.me.pk) this.room.addBot(k, info.botDiff)
    const t0 = this.room.entries().some(([k]) => slotTeam(k) === 0)
    const t1 = this.room.entries().some(([k]) => slotTeam(k) === 1)
    if (!t0 || !t1) {
      toast('双方都至少需要一名玩家或电脑 —— 已自动填充电脑', 'info')
      this.room.fillBots(info.botDiff)
    }
    this.room.start()
  }

  private send() {
    const inp = this.el.querySelector('.rc-in') as HTMLInputElement | null
    if (!inp) return
    const t = inp.value.trim()
    if (!t) return
    this.room.say({ n: this.host.me.name, pk: this.host.me.pk, t, tm: -1 })
    inp.value = ''
  }

  private tick() {
    if (this.dirty && !this.pickerOpen) { this.selOpen = false; this.dirty = false; this.render() }
    const info = this.room.info
    if (!info) return
    if (info.status === 'playing') { this.go(); return }
    const online = this.room.onlinePks()
    const now = Date.now()
    // owner migration
    if (!online.has(info.owner)) {
      if (!this.ownerAbsentSince) this.ownerAbsentSince = now
      if (now - this.ownerAbsentSince > 8000) {
        const humans = this.room.entries().filter(([, s]) => s.kind === 'human' && s.pk && online.has(s.pk)).map(([, s]) => s.pk!).sort()
        if (humans[0] === this.host.me.pk) {
          this.room.setMeta({ owner: this.host.me.pk, ownerName: this.host.me.name })
          this.room.say({ n: '系统', pk: '', t: `${this.host.me.name} 成为了房主`, tm: -1, sys: true })
        }
      }
    } else this.ownerAbsentSince = 0
    // I lost my slot (conflict) → reclaim
    if (!this.mySlot && !this.spectating) {
      const k = this.room.freeSlot()
      if (k) this.room.claim(k, this.host.me, { champ: settings.lastChamp, spells: settings.spells })
    }
    if (info.mm) {
      if (!this.countdownEnd) this.countdownEnd = (info.createdAt || now) + 32000
      const b = this.el.querySelector('.mm-cd')
      if (b) b.textContent = String(Math.max(0, Math.ceil((this.countdownEnd - Date.now()) / 1000)))
    }
    if (!this.isOwner) return
    // remove stale humans
    for (const [k, s] of this.room.entries()) {
      if (s.kind !== 'human' || !s.pk || s.pk === this.host.me.pk) continue
      if (online.has(s.pk)) { this.absentSince.delete(s.pk); continue }
      const t = this.absentSince.get(s.pk) ?? now
      this.absentSince.set(s.pk, t)
      if (now - t > (info.mm ? 20000 : 25000)) this.room.removeSlot(k)
    }
    // matchmade rooms auto start
    if (info.mm) {
      const humans = this.room.entries().filter(([, s]) => s.kind === 'human')
      const allHere = (info.expected ?? []).every(pk => online.has(pk))
      const allReady = humans.every(([, s]) => s.ready)
      const quickGo = info.quick && (allHere || now - (info.createdAt || now) > 10000)
      if ((allHere && allReady && humans.length > 0) || quickGo || now >= this.countdownEnd) {
        this.room.fillBots(info.botDiff)
        this.start()
      }
    }
  }

  private spectating = false

  private go() {
    if (this.started) return
    this.started = true
    this.host.startGame(this.room)
  }

  private renderChat() {
    const box = this.el.querySelector('.rc-log')
    if (!box) return
    const all = this.room.chat.toArray()
    const msgs = all.slice(-60)
    box.innerHTML = msgs.map((m: ChatMsg) => m.sys ? `<div class="sys">${esc(m.t)}</div>` : `<div><b>${esc(m.n)}:</b> ${esc(m.t)}</div>`).join('')
    box.scrollTop = box.scrollHeight
    // phone landscape: chat lives in a drawer, count what arrives while it is closed
    const fresh = Math.max(0, all.length - this.chatSeen)
    this.chatSeen = all.length
    if (fresh && this.plQuery.matches && !this.el.classList.contains('chat-open')) {
      this.unread += fresh
      this.updateUnread()
    }
  }

  render() {
    const info = this.room.info
    const main = this.el.querySelector('.rs-main') as HTMLElement
    if (!info) { main.innerHTML = '<div class="loading">正在连接房间…</div>'; this.lastHtml = ''; return }
    if (info.status === 'playing') { this.go(); return }
    if (this.pickerOpen) { this.dirty = true; return }
    this.selOpen = false
    const me = this.host.me
    const mySlot = this.mySlot
    const mine = mySlot ? this.room.slots.get(mySlot) : null
    const online = this.room.onlinePks()
    const owner = this.isOwner
    const slotCard = (k: string) => {
      const s = this.room.slots.get(k)
      if (!s) return `<div class="slot-card empty" data-act="slot" data-k="${k}"><span>空位</span>${owner ? `<button class="mini" data-act="addbot" data-k="${k}">+ 电脑</button>` : '<small>点击加入</small>'}</div>`
      const c = s.champ ? CHAMP_MAP[s.champ] : null
      const away = s.kind === 'human' && s.pk && !online.has(s.pk)
      const verified = s.kind === 'human' && this.room.verified(s)
      return `<div class="slot-card ${s.kind} ${s.pk === me.pk ? 'mine' : ''} ${away ? 'away' : ''}" ${s.kind === 'bot' && owner ? `data-act="slot" data-k="${k}"` : ''}>
        <div class="sc-face" style="background:${c ? champColor(c.color) : '#223'}">${c ? esc(c.name[0]) : '?'}</div>
        <div class="sc-info"><div class="sc-name">${esc(s.name)} ${verified ? '<span class="verified" title="Nostr 签名验证">✓</span>' : ''} ${s.pk === info.owner ? '<span class="crown" title="房主">👑</span>' : ''}</div>
          <div class="sc-sub">${c ? esc(c.name) + ' · ' + c.role : s.kind === 'bot' ? '随机英雄' : '选择英雄中…'}${s.kind === 'bot' ? ` · ${DIFF[s.diff ?? 1]}` : ''}</div></div>
        <div class="sc-state">${s.kind === 'bot' ? '🤖' : away ? '离线' : s.ready ? '<span class="ok">已准备</span>' : '<span class="wait">未准备</span>'}</div>
        ${owner && s.pk !== me.pk ? `<button class="mini x" data-act="kick" data-k="${k}" title="移除">✕</button>` : ''}
      </div>`
    }
    const keys = slotKeys(info.teamSize)
    const cd = () => info.mm && this.countdownEnd ? Math.max(0, Math.ceil((this.countdownEnd - Date.now()) / 1000)) : 0
    const detail = CHAMP_MAP[mine?.champ ?? this.detailChamp ?? 'blaze'] ?? CHAMPIONS[0]
    const humanCount = this.room.entries().filter(([, s]) => s.kind === 'human').length
    const html = `
      <div class="room-top">
        <button class="btn" data-act="leave">← 离开房间</button>
        <div class="room-title"><h2>${esc(info.name)}</h2><div class="room-meta"><span class="rm-txt">${MAPS[info.map]} · ${info.teamSize}v${info.teamSize} · 电脑难度 ${DIFF[info.botDiff]} · </span><span class="rm-id">房间号 <b>${esc(info.id)}</b></span> <button class="mini" data-act="copy">复制邀请链接</button></div></div>
        <div class="room-status">${this.room.yr.status === 'connected' ? '🟢 已连接' : '🟠 连接中'} · ${online.size} 人在线</div>
        <button class="btn rc-toggle" data-act="chat">聊天<span class="pill rc-unread ${this.unread ? '' : 'hidden'}">${this.unread}</span></button>
      </div>
      ${info.mm ? `<div class="mm-banner">⚔️ 匹配成功！${info.quick ? '所有玩家到齐后立即开始' : '选择你的英雄并准备 — <b class="mm-cd"></b> 秒后自动开始'}</div>` : ''}
      <div class="orient-hint">对局开始后请将手机横屏</div>
      <div class="room-body">
        <div class="team-col t0"><h3>蓝色方</h3>${keys.filter(k => slotTeam(k) === 0).map(slotCard).join('')}</div>
        <div class="room-mid">
          <div class="champ-grid">${CHAMPIONS.map(c => `
            <div class="champ-card ${mine?.champ === c.id ? 'sel' : ''}" data-act="champ" data-id="${c.id}">
              <div class="cc-face" style="background:radial-gradient(circle at 40% 35%, ${champColor(c.color)}, ${champColor(c.color2)})">${esc(c.name[0])}</div>
              <div class="cc-name">${esc(c.name)}</div><div class="cc-role">${c.role} ${'★'.repeat(c.diff)}${'☆'.repeat(3 - c.diff)}</div>
            </div>`).join('')}</div>
          <div class="champ-detail">
            <div class="cd-head"><b>${esc(detail.name)}</b> · ${esc(detail.title)} <small>${detail.role}</small></div>
            <div class="cd-lore">${esc(detail.lore)}</div>
            <div class="cd-skills">${detail.skills.map((s, i) => `<div class="cd-skill"><span class="cd-ic">${s.icon}</span><div><b>${'QWER'[i]} · ${esc(s.name)}</b><div>${esc(s.desc(1, null as any))}</div></div></div>`).join('')}</div>
          </div>
          <div class="room-controls">
            ${mine ? `<label><span class="lbl">召唤师技能</span> <select data-set="sp0">${SPELLS.map(s => `<option value="${s.id}" ${mine.spells[0] === s.id ? 'selected' : ''}>${s.icon} ${s.name}</option>`).join('')}</select>
              <select data-set="sp1">${SPELLS.map(s => `<option value="${s.id}" ${mine.spells[1] === s.id ? 'selected' : ''}>${s.icon} ${s.name}</option>`).join('')}</select></label>` : '<span class="muted">你正在观战</span>'}
            ${owner && !info.mm ? `
              <button class="btn rc-owner-btn" data-act="ownercfg" aria-label="房间设置">⚙<span class="rc-owner-t"> 设置</span></button>
              <span class="rc-owner"><label>地图 <select data-set="map">${Object.entries(MAPS).map(([k, v]) => `<option value="${k}" ${info.map === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
              <label>人数 <select data-set="size">${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${info.teamSize === n ? 'selected' : ''}>${n}v${n}</option>`).join('')}</select></label>
              <label>电脑 <select data-set="diff">${DIFF.map((d, i) => `<option value="${i}" ${info.botDiff === i ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
              <button class="btn" data-act="fill">填充电脑</button></span>` : ''}
            <div class="grow"></div>
            ${mine ? `<button class="btn ${mine.ready ? '' : 'btn-teal'}" data-act="ready">${mine.ready ? '取消准备' : '准备'}</button>` : ''}
            ${owner ? `<button class="btn-gold big" data-act="start">开始游戏</button>` : `<span class="muted">等待房主开始（${humanCount} 名玩家）</span>`}
          </div>
        </div>
        <div class="team-col t1"><h3>红色方</h3>${keys.filter(k => slotTeam(k) === 1).map(slotCard).join('')}</div>
      </div>`
    if (html !== this.lastHtml) {
      this.lastHtml = html
      // keep scroll positions across the rewrite (phones scroll .rs-main; desktop scrolls the inner panes);
      // a different champion's detail starts at the top
      const sameDetail = detail.id === this.shownDetail
      this.shownDetail = detail.id
      const keep = ['.room-mid', '.champ-detail', '.room-body'].map(s => [s, main.querySelector(s)?.scrollTop ?? 0] as const)
      const top = main.scrollTop
      main.innerHTML = html
      main.scrollTop = top
      for (const [s, v] of keep) {
        if (s === '.champ-detail' && !sameDetail) continue
        const e = main.querySelector(s)
        if (e && v) e.scrollTop = v
      }
    }
    // the countdown ticks every second; keep it out of the diffed html
    const b = main.querySelector('.mm-cd')
    if (b) b.textContent = String(cd())
  }

  destroy() {
    clearInterval(this.timer)
    for (const f of this.off) f()
    this.el.remove()
  }
}

export type { SlotInfo }
export { SPELL_MAP }
