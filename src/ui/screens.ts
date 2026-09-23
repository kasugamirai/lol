import type { App } from '../main'
import { el, esc, onAct, toast, modal, avatarHtml, copyText, champColor, fmtTime, confirmModal, promptModal } from './dom'
import { setName, exportNsec, importNsec, loginNip07, createIdentity, hasNip07, shortKey } from '../nostr/identity'
import { publishProfile, republishStats, fetchMyMatches, fetchLeaderboard, MatchRecord, LeaderRow } from '../nostr/store'
import { MM_MODES, MMMode } from '../net/lobby'
import { CHAMPIONS, CHAMP_MAP } from '../game/data/champions'
import { SPELLS } from '../game/data/spells'
import { settings, saveSettings, type Settings } from '../settings'
import { NOSTR_RELAYS, YJS_URL } from '../config'
import { sfx } from '../audio'
import type { MapId } from '../game/mapdef'
import { mobileActive, applyDeviceClasses, canFullscreen, requestFullscreen } from './device'

const winRate = (w: number, g: number) => (g ? Math.round((w / g) * 100) : 0) + '%'
const kda = (k: number, d: number, a: number) => ((k + a) / Math.max(1, d)).toFixed(2)
const MAP_NAME: Record<string, string> = { rift: '召唤师峡谷', aram: '极地大乱斗' }

function connBadge(app: App) {
  const st = app.lobby.status
  return `<span class="conn ${st}">${st === 'connected' ? '● Yjs 中继已连接' : st === 'connecting' ? '● 正在连接中继…' : '● 中继已断开（重连中）'}</span> <span class="muted">在线 ${app.lobby.online()} 人</span>`
}

// ======================================================================== menu
export class MenuScreen {
  readonly el: HTMLDivElement
  private off: (() => void)[] = []
  constructor(private app: App) {
    this.el = el('div', 'screen menu-screen')
    document.getElementById('app')!.appendChild(this.el)
    this.render()
    this.off.push(app.lobby.onChange(() => this.renderLive()))
    this.off.push(app.onStats(() => this.render()))
    this.off.push(onAct(this.el, {
      match: () => this.pickMode(),
      rooms: () => app.showRooms(),
      practice: () => app.practice(),
      profile: () => app.showProfile('stats'),
      board: () => app.showProfile('board'),
      account: () => app.showProfile('account'),
      rename: () => this.rename(),
      copy: () => copyText(app.id.npub),
      settings: () => settingsModal(),
      help: () => helpModal(),
      fullscreen: () => toggleFullscreen(),
    }))
  }

  private pickMode() {
    const m = modal(`<h3>快速匹配</h3><p class="muted">与在线玩家匹配对战，人数不足时由电脑补位。</p>
      <div class="mode-list">${(Object.keys(MM_MODES) as MMMode[]).map(k => `<button class="mode-btn" data-mode="${k}"><b>${MM_MODES[k].label}</b><small>${k === 'rift' ? '经典三路推塔 · 野区 · 巨龙与男爵' : '单路混战 · 3级起步 · 快节奏团战'}</small></button>`).join('')}</div>
      <div class="modal-btns"><button class="btn" data-close>取消</button></div>`)
    m.box.querySelectorAll<HTMLElement>('[data-mode]').forEach(b => b.addEventListener('click', () => {
      // the match starts later without a user gesture, so go fullscreen now (mobile only, best effort)
      requestFullscreen()
      m.close()
      this.app.quickMatch(b.dataset.mode as MMMode)
    }))
  }

  private async rename() {
    const title = '输入新的召唤师名称（最多16个字符）'
    const n = mobileActive() ? await promptModal(title, this.app.id.name, 16) : prompt(title, this.app.id.name)
    if (!n || !n.trim()) return
    setName(n.trim())
    this.app.identityChanged()
    this.render()
    publishProfile(n.trim()).then(r => toast(r.ok ? `名称已更新并发布到 ${r.ok} 个 Nostr 中继` : '名称已更新（Nostr 发布失败）', r.ok ? 'ok' : 'info')).catch(() => {})
    republishStats(n.trim())
  }

  private renderLive() {
    const c = this.el.querySelector('.menu-conn')
    if (c) c.innerHTML = connBadge(this.app)
    const r = this.el.querySelector('.menu-rooms-n')
    if (r) r.textContent = String(this.app.lobby.rooms().length)
  }

  render() {
    const id = this.app.id
    const s = this.app.stats
    this.el.innerHTML = `
      <div class="menu-bg"></div>
      <div class="menu-top"><div class="menu-conn">${connBadge(this.app)}</div>${canFullscreen() ? '<button class="icon-btn touch-only" data-act="fullscreen" title="全屏" aria-label="全屏">⛶</button>' : ''}<button class="icon-btn" data-act="help" title="操作说明" aria-label="操作说明">❔</button><button class="icon-btn" data-act="settings" title="设置" aria-label="设置">⚙️</button></div>
      <div class="menu-center">
        <div class="logo"><div class="logo-cn">星核峡谷</div><div class="logo-en">NEXUS RIFT</div><div class="logo-sub">5v5 多人在线战术竞技 · Yjs 实时同步 · Nostr 身份</div></div>
        <div class="menu-buttons">
          <button class="btn-gold huge" data-act="match">⚔️ 快速匹配</button>
          <div class="menu-row">
            <button class="btn big" data-act="rooms">🏠 房间列表 <span class="pill menu-rooms-n">${this.app.lobby.rooms().length}</span></button>
            <button class="btn big" data-act="practice">🤖 人机练习</button>
          </div>
          <div class="menu-row">
            <button class="btn" data-act="profile">📜 我的战绩</button>
            <button class="btn" data-act="board">🏆 排行榜</button>
            <button class="btn" data-act="account">🔑 Nostr 账户</button>
          </div>
        </div>
      </div>
      <div class="player-card">
        ${avatarHtml(id.name, id.avatar, 58)}
        <div class="pc-info">
          <div class="pc-name">${esc(id.name)} <button class="mini" data-act="rename" title="修改名称" aria-label="修改名称">✏️</button></div>
          <div class="pc-key" data-act="copy" title="点击复制 npub">${esc(shortKey(id.npub))} <span class="badge">${id.method === 'nip07' ? '扩展登录' : id.method === 'nsec' ? '私钥登录' : '自动账户'}</span></div>
          <div class="pc-stats">${s ? `积分 <b>${s.rating}</b> · ${s.games} 场 · 胜率 ${winRate(s.wins, s.games)} · KDA ${kda(s.kills, s.deaths, s.assists)}` : '暂无战绩 — 打一局吧！'}</div>
        </div>
      </div>
      <div class="menu-foot">数据存储于 Nostr 中继 · 对战同步经由 ${esc(YJS_URL.replace('wss://', ''))}</div>`
  }

  destroy() {
    for (const f of this.off) f()
    this.el.remove()
  }
}

// ======================================================================== rooms
export class RoomsScreen {
  readonly el: HTMLDivElement
  private off: (() => void)[] = []
  constructor(private app: App) {
    this.el = el('div', 'screen rooms-screen')
    document.getElementById('app')!.appendChild(this.el)
    this.el.innerHTML = `
      <div class="page-head"><button class="btn" data-act="back">← 返回</button><h2>房间列表</h2><div class="rooms-conn">${connBadge(app)}</div></div>
      <div class="rooms-body">
        <div class="rooms-list panel"><div class="rl-head"><b>公开房间</b><span class="muted">房间通过 Yjs 大厅实时广播</span></div><div class="rl-items"></div></div>
        <div class="rooms-side">
          <div class="panel create">
            <h3>创建房间</h3>
            <label>房间名 <input class="c-name" maxlength="20" value="${esc(app.id.name)}的房间" enterkeyhint="done" autocomplete="off"></label>
            <label>地图 <select class="c-map"><option value="rift">召唤师峡谷（三路）</option><option value="aram">极地大乱斗（单路）</option></select></label>
            <label>人数 <select class="c-size">${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${n === 5 ? 'selected' : ''}>${n}v${n}</option>`).join('')}</select></label>
            <label>电脑难度 <select class="c-diff"><option value="0">简单</option><option value="1" selected>普通</option><option value="2">困难</option></select></label>
            <label class="chk"><input type="checkbox" class="c-priv"> 私密房间（不在列表显示，通过房间号/链接加入）</label>
            <button class="btn-gold" data-act="create">创建房间</button>
          </div>
          <div class="panel">
            <h3>通过房间号加入</h3>
            <div class="row"><input class="j-id" placeholder="房间号，例如 k3m9xa" maxlength="12" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go"><button class="btn" data-act="join">加入</button></div>
          </div>
        </div>
      </div>`
    this.renderList()
    this.off.push(app.lobby.onChange(() => this.renderList()))
    this.off.push(onAct(this.el, {
      back: () => app.showMenu(),
      create: () => {
        const q = <T extends HTMLElement>(s: string) => this.el.querySelector(s) as T
        app.createRoom({
          name: q<HTMLInputElement>('.c-name').value.trim() || '新房间',
          map: q<HTMLSelectElement>('.c-map').value as MapId,
          teamSize: Number(q<HTMLSelectElement>('.c-size').value),
          botDiff: Number(q<HTMLSelectElement>('.c-diff').value),
          priv: q<HTMLInputElement>('.c-priv').checked,
        })
      },
      join: () => this.join(),
      enter: t => { requestFullscreen(); app.joinRoom(t.dataset.id!) },
    }))
    this.el.addEventListener('keydown', e => {
      // mobile keyboards show a 前往 key (enterkeyhint="go") on the room-id field
      if (mobileActive() && e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && (e.target as HTMLElement).classList.contains('j-id')) this.join()
    })
  }

  private join() {
    // room ids are lowercase; mobile keyboards like to capitalize the first letter
    const v = (this.el.querySelector('.j-id') as HTMLInputElement).value.trim().replace(/.*room=/, '').replace(/[^a-z0-9]/gi, '').toLowerCase()
    if (!v) return
    requestFullscreen()
    this.app.joinRoom(v)
  }

  private listHtml = ''
  private connHtml = ''
  private renderList() {
    const box = this.el.querySelector('.rl-items')
    if (!box) return
    // only touch the DOM when something changed: rewriting nodes under a finger drops the tap
    const conn = this.el.querySelector('.rooms-conn')
    const connHtml = connBadge(this.app)
    if (conn && connHtml !== this.connHtml) { conn.innerHTML = connHtml; this.connHtml = connHtml }
    const rooms = this.app.lobby.rooms()
    const html = rooms.length ? rooms.map(r => `
      <div class="room-row">
        <div class="rr-map ${r.map}">${r.map === 'aram' ? '❄️' : '🌲'}</div>
        <div class="rr-info"><b>${esc(r.name)}</b><div class="muted">${MAP_NAME[r.map]} · ${r.teamSize}v${r.teamSize} · 房主 ${esc(r.ownerName)} · #${esc(r.id)}</div></div>
        <div class="rr-meta"><div class="rr-n">${r.humans}/${r.teamSize * 2}</div><div class="rr-st ${r.status}">${r.status === 'lobby' ? '等待中' : '游戏中'}</div></div>
        <button class="btn ${r.status === 'lobby' ? 'btn-teal' : ''}" data-act="enter" data-id="${esc(r.id)}">${r.status === 'lobby' ? '加入' : '观战'}</button>
      </div>`).join('') : `<div class="empty-note">暂无公开房间。创建一个房间，把房间号发给朋友吧！<br><span class="muted">也可以使用「快速匹配」与在线玩家对战。</span></div>`
    if (html === this.listHtml) return
    this.listHtml = html
    box.innerHTML = html
  }

  destroy() {
    for (const f of this.off) f()
    this.el.remove()
  }
}

// ======================================================================== profile / leaderboard / account
export class ProfileScreen {
  readonly el: HTMLDivElement
  private off: (() => void)[] = []
  private matches: MatchRecord[] | null = null
  private board: LeaderRow[] | null = null

  constructor(private app: App, private tab: 'stats' | 'board' | 'account') {
    this.el = el('div', 'screen profile-screen')
    document.getElementById('app')!.appendChild(this.el)
    this.off.push(app.onStats(() => this.render()))
    this.off.push(onAct(this.el, {
      back: () => app.showMenu(),
      tab: t => { this.tab = t.dataset.tab as any; this.render(); this.load() },
      copy: t => copyText(t.dataset.v!),
      reveal: () => this.reveal(),
      import: () => this.importKey(),
      nip07: () => this.nip07(),
      newid: () => this.newId(),
      publish: () => publishProfile(app.id.name).then(r => toast(`资料已发布到 ${r.ok}/${r.ok + r.fail} 个中继`, r.ok ? 'ok' : 'err')).catch(e => toast(String(e.message ?? e), 'err')),
      reload: () => { this.matches = null; this.board = null; this.render(); this.load() },
    }))
    this.render()
    this.load()
  }

  private load() {
    if (this.tab === 'stats' && !this.matches) {
      fetchMyMatches().then(m => { this.matches = m; this.render() }).catch(() => { this.matches = []; this.render() })
      this.app.refreshStats()
    }
    if (this.tab === 'board' && !this.board) fetchLeaderboard().then(b => { this.board = b; this.render() }).catch(() => { this.board = []; this.render() })
  }

  private reveal() {
    const n = exportNsec()
    if (!n) { toast('当前账户使用浏览器扩展登录，私钥由扩展保管', 'info'); return }
    const m = modal(`<h3>⚠️ 备份私钥</h3><p>这是你的 Nostr 私钥（nsec），拥有它就能完全控制你的账户和战绩。请妥善保存，切勿泄露给任何人。</p>
      <div class="secret">${esc(n)}</div><div class="modal-btns"><button class="btn" data-copy>复制</button><button class="btn-gold" data-close>完成</button></div>`)
    m.box.querySelector('[data-copy]')!.addEventListener('click', () => copyText(n))
  }

  private importKey() {
    const m = modal(`<h3>导入 Nostr 私钥</h3><p class="muted">粘贴 nsec1… 或 64 位十六进制私钥。当前的自动账户将被替换（请先备份）。</p>
      <input class="imp" placeholder="nsec1..." autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"><div class="modal-btns"><button class="btn" data-close>取消</button><button class="btn-gold" data-ok>导入</button></div>`)
    m.box.querySelector('[data-ok]')!.addEventListener('click', () => {
      try {
        importNsec((m.box.querySelector('.imp') as HTMLInputElement).value)
        m.close()
        this.app.identityChanged()
        this.matches = null
        toast('已使用导入的私钥登录', 'ok')
        this.render()
      } catch (e: any) { toast(e.message ?? String(e), 'err') }
    })
  }

  private async nip07() {
    try {
      await loginNip07()
      this.app.identityChanged()
      this.matches = null
      toast('已通过 Nostr 扩展登录', 'ok')
      this.render()
    } catch (e: any) { toast(e.message ?? String(e), 'err') }
  }

  private async newId() {
    const q = '创建新账户将替换当前账户。如未备份私钥，当前账户将无法找回。确定继续？'
    if (!(mobileActive() ? await confirmModal(q, '创建新账户', true) : confirm(q))) return
    createIdentity()
    this.app.identityChanged()
    this.matches = null
    toast('已创建新的 Nostr 账户', 'ok')
    this.render()
  }

  render() {
    const id = this.app.id
    const s = this.app.stats
    const tabs = `<div class="tabs">${[['stats', '我的战绩'], ['board', '排行榜'], ['account', 'Nostr 账户']].map(([k, n]) => `<button class="${this.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${n}</button>`).join('')}</div>`
    let body = ''
    if (this.tab === 'stats') {
      const favs = s ? Object.entries(s.champs).sort((a, b) => b[1].g - a[1].g).slice(0, 4) : []
      body = `
        <div class="stat-cards">
          <div class="scard"><b>${s?.rating ?? 1000}</b><span>积分</span></div>
          <div class="scard"><b>${s?.games ?? 0}</b><span>总场次</span></div>
          <div class="scard"><b>${s ? winRate(s.wins, s.games) : '0%'}</b><span>胜率 (${s?.wins ?? 0}胜 ${s?.losses ?? 0}负)</span></div>
          <div class="scard"><b>${s ? kda(s.kills, s.deaths, s.assists) : '0.00'}</b><span>KDA (${s?.kills ?? 0}/${s?.deaths ?? 0}/${s?.assists ?? 0})</span></div>
          <div class="scard"><b>${s?.cs ?? 0}</b><span>总补刀</span></div>
        </div>
        ${favs.length ? `<div class="favs">常用英雄：${favs.map(([c, v]) => `<span class="fav"><span class="sb-face" style="background:${champColor(CHAMP_MAP[c]?.color ?? 0x888888)}">${esc(CHAMP_MAP[c]?.name[0] ?? '?')}</span>${esc(CHAMP_MAP[c]?.name ?? c)} ${v.g}场 ${winRate(v.w, v.g)}</span>`).join('')}</div>` : ''}
        <div class="panel"><div class="rl-head"><b>最近对局</b><span class="muted">来自 Nostr 中继 (kind 30078)</span><button class="mini" data-act="reload">刷新</button></div>
        ${this.matches === null ? '<div class="loading-inline"><div class="spinner sm"></div> 正在从 Nostr 中继读取…</div>' : this.matches.length === 0 ? '<div class="empty-note">暂无对局记录</div>' : this.matches.map(m => `
          <div class="match-row ${m.win ? 'win' : 'loss'}">
            <div class="mr-res">${m.win ? '胜利' : '失败'}<small>${MAP_NAME[m.map] ?? m.map}</small></div>
            <span class="sb-face big" style="background:${champColor(CHAMP_MAP[m.champ]?.color ?? 0x888888)}">${esc(CHAMP_MAP[m.champ]?.name[0] ?? '?')}</span>
            <div class="mr-kda"><b>${m.k}/${m.d}/${m.a}</b><small>Lv${m.level} · 补刀 ${m.cs}</small></div>
            <div class="mr-players">${m.players.map(p => `<span class="${p.t === m.team ? 'ally' : 'enemy'}">${esc(p.n)}</span>`).join('')}</div>
            <div class="mr-time">${fmtTime(m.duration)}<small>${new Date(m.endedAt).toLocaleString()}</small></div>
          </div>`).join('')}</div>`
    } else if (this.tab === 'board') {
      body = `<div class="panel"><div class="rl-head"><b>全球排行榜</b><span class="muted">聚合自 Nostr 中继上所有玩家发布的战绩</span><button class="mini" data-act="reload">刷新</button></div>
        ${this.board === null ? '<div class="loading-inline"><div class="spinner sm"></div> 正在从 Nostr 中继读取…</div>' : this.board.length === 0 ? '<div class="empty-note">暂无数据</div>' : `
        <table class="board"><tr><th>#</th><th>玩家</th><th>积分</th><th>场次</th><th>胜率</th><th>KDA</th><th>公钥</th></tr>
        ${this.board.slice(0, 100).map((r, i) => `<tr class="${r.pk === id.pk ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.name || '匿名')}</td><td><b>${r.rating}</b></td><td>${r.games}</td><td>${winRate(r.wins, r.games)}</td><td>${kda(r.kills, r.deaths, r.assists)}</td><td class="mono">${esc(r.pk.slice(0, 8))}…</td></tr>`).join('')}</table>`}</div>`
    } else {
      body = `
        <div class="panel account">
          <div class="acc-row">${avatarHtml(id.name, id.avatar, 64)}<div><div class="pc-name">${esc(id.name)}</div><div class="muted">登录方式：${id.method === 'nip07' ? 'NIP-07 浏览器扩展' : id.method === 'nsec' ? '导入的私钥' : '自动生成的账户（首次打开时创建）'}</div></div></div>
          <label>公钥 (npub)</label><div class="keybox mono" data-act="copy" data-v="${esc(id.npub)}">${esc(id.npub)}</div>
          <label>公钥 (hex)</label><div class="keybox mono" data-act="copy" data-v="${esc(id.pk)}">${esc(id.pk)}</div>
          <div class="acc-btns">
            <button class="btn" data-act="publish">📡 发布资料到 Nostr</button>
            <button class="btn" data-act="reveal">🔐 备份私钥</button>
            <button class="btn" data-act="import">📥 导入私钥</button>
            <button class="btn" data-act="nip07" ${hasNip07() ? '' : 'disabled title="未检测到 Nostr 浏览器扩展"'}>🧩 扩展登录 (NIP-07)</button>
            <button class="btn danger" data-act="newid">🆕 创建新账户</button>
          </div>
          ${hasNip07() ? '' : '<div class="muted small touch-only nip07-note">移动端浏览器通常不支持 Nostr 扩展，可使用「导入私钥」</div>'}
          <div class="muted small">你的身份是一个 Nostr 密钥对：进入房间时会用私钥签名证明身份，战绩以 NIP-78 应用数据 (kind 30078) 发布到以下中继：</div>
          <div class="relays">${NOSTR_RELAYS.map(r => `<span class="relay mono">${esc(r)}</span>`).join('')}</div>
        </div>`
    }
    this.el.innerHTML = `<div class="page-head"><button class="btn" data-act="back">← 返回</button><h2>召唤师档案</h2>${tabs}</div><div class="profile-body">${body}</div>`
  }

  destroy() {
    for (const f of this.off) f()
    this.el.remove()
  }
}

// ======================================================================== modals
export function practiceModal(app: App) {
  let champ = settings.lastChamp
  const m = modal(`
    <h3>人机练习</h3>
    <div class="pm-grid">
      <label>地图 <select class="p-map"><option value="rift" ${settings.practiceMap === 'rift' ? 'selected' : ''}>召唤师峡谷（三路）</option><option value="aram" ${settings.practiceMap === 'aram' ? 'selected' : ''}>极地大乱斗（单路）</option></select></label>
      <label>规模 <select class="p-size">${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${settings.practiceSize === n ? 'selected' : ''}>${n}v${n}</option>`).join('')}</select></label>
      <label>电脑难度 <select class="p-diff">${['简单', '普通', '困难'].map((d, i) => `<option value="${i}" ${settings.botDiff === i ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
      <label>召唤师技能 <select class="p-sp0">${SPELLS.map(s => `<option value="${s.id}" ${settings.spells[0] === s.id ? 'selected' : ''}>${s.icon} ${s.name}</option>`).join('')}</select>
        <select class="p-sp1">${SPELLS.map(s => `<option value="${s.id}" ${settings.spells[1] === s.id ? 'selected' : ''}>${s.icon} ${s.name}</option>`).join('')}</select></label>
    </div>
    <div class="champ-grid small">${CHAMPIONS.map(c => `<div class="champ-card ${c.id === champ ? 'sel' : ''}" data-id="${c.id}"><div class="cc-face" style="background:radial-gradient(circle at 40% 35%, ${champColor(c.color)}, ${champColor(c.color2)})">${esc(c.name[0])}</div><div class="cc-name">${esc(c.name)}</div><div class="cc-role">${c.role}</div></div>`).join('')}</div>
    <div class="modal-btns"><button class="btn" data-close>取消</button><button class="btn-gold" data-go>开始游戏</button></div>`, { cls: 'wide' })
  m.box.querySelectorAll<HTMLElement>('.champ-card').forEach(c => c.addEventListener('click', () => {
    champ = c.dataset.id!
    m.box.querySelectorAll('.champ-card').forEach(x => x.classList.toggle('sel', x === c))
    sfx.play('click')
  }))
  m.box.querySelector('[data-go]')!.addEventListener('click', () => {
    const q = <T extends HTMLElement>(s: string) => m.box.querySelector(s) as T
    settings.practiceMap = q<HTMLSelectElement>('.p-map').value as MapId
    settings.practiceSize = Number(q<HTMLSelectElement>('.p-size').value)
    settings.botDiff = Number(q<HTMLSelectElement>('.p-diff').value)
    const sp0 = q<HTMLSelectElement>('.p-sp0').value, sp1 = q<HTMLSelectElement>('.p-sp1').value
    settings.spells = [sp0, sp1 === sp0 ? SPELLS.find(s => s.id !== sp0)!.id : sp1]
    settings.lastChamp = champ
    saveSettings()
    requestFullscreen()
    m.close()
    app.createRoom({ name: '人机练习', map: settings.practiceMap, teamSize: settings.practiceSize, botDiff: settings.botDiff, priv: true, fill: true, autostart: true })
  })
}

const sel = (on: boolean) => (on ? 'selected' : '')
const pct = (v: number) => Math.round(v * 100) + '%'

export function settingsModal() {
  const m = modal(`<h3>设置</h3>
    <label>音量 <input type="range" min="0" max="1" step="0.05" class="s-vol" value="${settings.volume}"></label>
    <label>操作模式 <select class="s-mobile"><option value="auto" ${sel(settings.mobileMode === 'auto')}>自动检测</option><option value="on" ${sel(settings.mobileMode === 'on')}>触屏</option><option value="off" ${sel(settings.mobileMode === 'off')}>键鼠</option></select></label>
    <label class="kbd-only">施法方式 <select class="s-cast"><option value="quick" ${sel(settings.castMode === 'quick')}>快速施法（按键即释放，朝向鼠标）</option><option value="indicator" ${sel(settings.castMode === 'indicator')}>指示器施法（按住显示范围，松开释放）</option></select></label>
    <div class="touch-only s-touch">
      <label>摇杆 <select class="s-joy"><option value="dynamic" ${sel(settings.joyMode === 'dynamic')}>动态（跟随拇指）</option><option value="fixed" ${sel(settings.joyMode === 'fixed')}>固定位置</option></select></label>
      <label>攻击优先 <select class="s-atk"><option value="lowhp" ${sel(settings.atkPri === 'lowhp')}>血量最低的英雄</option><option value="near" ${sel(settings.atkPri === 'near')}>距离最近的英雄</option></select></label>
      <label>界面缩放 <input type="range" min="0.8" max="1.3" step="0.05" class="s-uis" value="${settings.uiScale}"><span class="s-val s-uis-v">${pct(settings.uiScale)}</span></label>
      <label>镜头距离 <input type="range" min="0.7" max="1" step="0.02" class="s-zoom" value="${settings.touchZoom}"><span class="s-val s-zoom-v">${pct(settings.touchZoom)}</span></label>
      <label class="chk"><input type="checkbox" class="s-aimcam" ${settings.aimCam ? 'checked' : ''}> 远程技能瞄准时镜头前移</label>
    </div>
    <label>画质 <select class="s-q"><option value="1" ${sel(settings.quality === 1)}>高（抗锯齿 + 高清）</option><option value="0" ${sel(settings.quality === 0)}>性能优先</option></select></label>
    <label class="chk"><input type="checkbox" class="s-shadow" ${settings.shadows ? 'checked' : ''}> 实时阴影</label>
    <label class="chk kbd-only"><input type="checkbox" class="s-edge" ${settings.edgePan ? 'checked' : ''}> 屏幕边缘移动镜头（镜头解锁时）</label>
    <label class="chk kbd-only"><input type="checkbox" class="s-lock" ${settings.camLock ? 'checked' : ''}> 默认锁定镜头跟随英雄</label>
    <label class="chk"><input type="checkbox" class="s-fps" ${settings.showFps ? 'checked' : ''}> 显示 FPS</label>
    <div class="modal-btns"><button class="btn-gold" data-close>完成</button></div>`)
  const b = m.box
  const q = <T extends HTMLElement>(s: string) => b.querySelector(s) as T
  b.addEventListener('input', () => {
    settings.volume = Number(q<HTMLInputElement>('.s-vol').value)
    settings.castMode = q<HTMLSelectElement>('.s-cast').value as any
    settings.quality = Number(q<HTMLSelectElement>('.s-q').value) as 0 | 1
    settings.shadows = q<HTMLInputElement>('.s-shadow').checked
    settings.edgePan = q<HTMLInputElement>('.s-edge').checked
    settings.camLock = q<HTMLInputElement>('.s-lock').checked
    settings.showFps = q<HTMLInputElement>('.s-fps').checked
    settings.joyMode = q<HTMLSelectElement>('.s-joy').value as Settings['joyMode']
    settings.atkPri = q<HTMLSelectElement>('.s-atk').value as Settings['atkPri']
    settings.uiScale = Number(q<HTMLInputElement>('.s-uis').value) || 1
    settings.touchZoom = Number(q<HTMLInputElement>('.s-zoom').value) || 0.82
    settings.aimCam = q<HTMLInputElement>('.s-aimcam').checked
    q('.s-uis-v').textContent = pct(settings.uiScale)
    q('.s-zoom-v').textContent = pct(settings.touchZoom)
    const mode = q<HTMLSelectElement>('.s-mobile').value as Settings['mobileMode']
    if (mode !== settings.mobileMode) {
      settings.mobileMode = mode
      // the in-game touch UI is frozen per match; menus switch right away
      if (!document.body.classList.contains('in-game')) applyDeviceClasses()
    }
    sfx.setVolume(settings.volume)
    saveSettings()
  })
}

export function helpModal() {
  modal(`<h3>操作说明</h3>
    <div class="help">
      <div class="kbd-only">
        <div><kbd>右键</kbd> 移动 / 攻击目标（按住持续移动）</div>
        <div><kbd>A</kbd> + <kbd>左键</kbd> 攻击移动　<kbd>S</kbd> 停止</div>
        <div><kbd>Q</kbd><kbd>W</kbd><kbd>E</kbd><kbd>R</kbd> 释放技能（朝向鼠标）</div>
        <div><kbd>Alt/Ctrl</kbd> + <kbd>Q</kbd>… 升级技能（或点击技能上方的 +）</div>
        <div><kbd>D</kbd><kbd>F</kbd> 召唤师技能　<kbd>1</kbd>-<kbd>7</kbd> 使用物品　<kbd>4</kbd> 放置守卫</div>
        <div><kbd>B</kbd> 回城　<kbd>P</kbd> 商店（泉水内或阵亡时购买）</div>
        <div><kbd>Tab</kbd> 数据面板　<kbd>Y</kbd> 锁定/解锁镜头　<kbd>空格</kbd> 镜头回到英雄</div>
        <div><kbd>G</kbd> 标记信号　<kbd>Enter</kbd> 聊天　<kbd>Esc</kbd> 菜单　滚轮缩放</div>
      </div>
      <div class="touch-only">
        <div>🕹️ 左侧拖动摇杆移动</div>
        <div>🎯 右下 ⚔ 普通攻击（按住持续攻击，自动选目标；🗡 补刀优先小兵，🏰 推塔优先建筑）</div>
        <div>✨ 技能：点击快速释放，按住拖动瞄准，拖到「取消」放弃</div>
        <div>➕ 技能旁 + 升级 · 点击敌人锁定攻击目标</div>
        <div>🗺️ 左上小地图：按住查看、长按发信号</div>
        <div>💰 商店 · 🛒 一键购买 · 🏠 回城 · 右上 📊 数据 / 💬 聊天 / ⚙️ 菜单</div>
        <div class="muted small">对局需横屏进行；操作模式可在 设置 中切换（下局生效）</div>
      </div>
      <p class="muted">目标：摧毁敌方的防御塔、水晶枢纽，最终摧毁敌方星核即可获胜。击杀小兵和野怪获取金币与经验，击杀巨龙和男爵获得团队增益。</p>
    </div>
    <div class="modal-btns"><button class="btn-gold" data-close>明白了</button></div>`)
}

/** menu fullscreen button (touch-only, rendered only where the Fullscreen API exists) */
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
  else requestFullscreen()
}
