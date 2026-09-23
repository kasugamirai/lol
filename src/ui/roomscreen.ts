import { MatchRoom, SlotInfo, slotKeys, slotTeam, ChatMsg } from '../net/room'
import { CHAMPIONS, CHAMP_MAP } from '../game/data/champions'
import { SPELLS, SPELL_MAP } from '../game/data/spells'
import { el, esc, onAct, toast, champColor, copyText } from './dom'
import { settings, saveSettings } from '../settings'
import { sfx } from '../audio'
import type { MapId } from '../game/mapdef'

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
      ready: () => this.toggleReady(),
      start: () => this.start(),
      fill: () => { this.room.fillBots(this.room.info?.botDiff ?? 1); sfx.play('click') },
      copy: () => copyText(location.origin + location.pathname + '?room=' + this.room.id),
      send: () => this.send(),
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
    })
    this.el.addEventListener('keydown', e => {
      if ((e.target as HTMLElement).classList.contains('rc-in') && e.key === 'Enter') this.send()
    })
    this.el.innerHTML = `<div class="rs-main"></div><div class="room-chat"><div class="rc-log"></div><div class="rc-row"><input class="rc-in" maxlength="140" placeholder="聊天…（Enter 发送）"><button class="btn" data-act="send">发送</button></div></div>`
    this.timer = window.setInterval(() => this.tick(), 1000)
    this.render()
    this.renderChat()
  }

  private get isOwner() { return this.room.info?.owner === this.host.me.pk }
  private get mySlot() { return this.room.slotOf(this.host.me.pk) }

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
    const msgs = this.room.chat.toArray().slice(-60)
    box.innerHTML = msgs.map((m: ChatMsg) => m.sys ? `<div class="sys">${esc(m.t)}</div>` : `<div><b>${esc(m.n)}:</b> ${esc(m.t)}</div>`).join('')
    box.scrollTop = box.scrollHeight
    void this.chatSeen
  }

  render() {
    const info = this.room.info
    const main = this.el.querySelector('.rs-main') as HTMLElement
    if (!info) { main.innerHTML = '<div class="loading">正在连接房间…</div>'; return }
    if (info.status === 'playing') { this.go(); return }
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
    const cd = info.mm && this.countdownEnd ? Math.max(0, Math.ceil((this.countdownEnd - Date.now()) / 1000)) : 0
    const detail = CHAMP_MAP[mine?.champ ?? this.detailChamp ?? 'blaze'] ?? CHAMPIONS[0]
    const humanCount = this.room.entries().filter(([, s]) => s.kind === 'human').length
    main.innerHTML = `
      <div class="room-top">
        <button class="btn" data-act="leave">← 离开房间</button>
        <div class="room-title"><h2>${esc(info.name)}</h2><div class="room-meta">${MAPS[info.map]} · ${info.teamSize}v${info.teamSize} · 电脑难度 ${DIFF[info.botDiff]} · 房间号 <b>${esc(info.id)}</b> <button class="mini" data-act="copy">复制邀请链接</button></div></div>
        <div class="room-status">${this.room.yr.status === 'connected' ? '🟢 已连接' : '🟠 连接中'} · ${online.size} 人在线</div>
      </div>
      ${info.mm ? `<div class="mm-banner">⚔️ 匹配成功！${info.quick ? '所有玩家到齐后立即开始' : `选择你的英雄并准备 — <b class="mm-cd">${cd}</b> 秒后自动开始`}</div>` : ''}
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
            ${mine ? `<label>召唤师技能 <select data-set="sp0">${SPELLS.map(s => `<option value="${s.id}" ${mine.spells[0] === s.id ? 'selected' : ''}>${s.icon} ${s.name}</option>`).join('')}</select>
              <select data-set="sp1">${SPELLS.map(s => `<option value="${s.id}" ${mine.spells[1] === s.id ? 'selected' : ''}>${s.icon} ${s.name}</option>`).join('')}</select></label>` : '<span class="muted">你正在观战</span>'}
            ${owner && !info.mm ? `
              <label>地图 <select data-set="map">${Object.entries(MAPS).map(([k, v]) => `<option value="${k}" ${info.map === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
              <label>人数 <select data-set="size">${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${info.teamSize === n ? 'selected' : ''}>${n}v${n}</option>`).join('')}</select></label>
              <label>电脑 <select data-set="diff">${DIFF.map((d, i) => `<option value="${i}" ${info.botDiff === i ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
              <button class="btn" data-act="fill">填充电脑</button>` : ''}
            <div class="grow"></div>
            ${mine ? `<button class="btn ${mine.ready ? '' : 'btn-teal'}" data-act="ready">${mine.ready ? '取消准备' : '准备'}</button>` : ''}
            ${owner ? `<button class="btn-gold big" data-act="start">开始游戏</button>` : `<span class="muted">等待房主开始（${humanCount} 名玩家）</span>`}
          </div>
        </div>
        <div class="team-col t1"><h3>红色方</h3>${keys.filter(k => slotTeam(k) === 1).map(slotCard).join('')}</div>
      </div>`
  }

  destroy() {
    clearInterval(this.timer)
    for (const f of this.off) f()
    this.el.remove()
  }
}

export type { SlotInfo }
export { SPELL_MAP }
