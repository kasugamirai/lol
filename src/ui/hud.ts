import type { World } from '../game/world'
import { Unit } from '../game/unit'
import { Champion, canUpgradeSkill } from '../game/champion'
import { ITEMS, ITEM_MAP, statLine, SELL_RATIO, ItemDef } from '../game/data/items'
import { SPELL_MAP } from '../game/data/spells'
import { CastKey, F, ITEM_KEYS } from '../game/types'
import { xpToNext } from '../game/data/units'
import { el, esc, fmtTime, champColor } from './dom'
import { settings, saveSettings } from '../settings'
import { sfx } from '../audio'

export interface HudActions {
  levelSkill(i: number): void
  cast(key: CastKey): void
  buy(id: string): void
  sell(slot: number): void
  recall(): void
  chat(text: string, all: boolean): void
  quit(): void
  surrender?(): void
  applySettings(): void
}

const SKEYS: CastKey[] = ['Q', 'W', 'E', 'R']
const SHOP_TABS: { id: string; name: string; f: (i: ItemDef) => boolean }[] = [
  { id: 'rec', name: '推荐', f: () => false },
  { id: 'basic', name: '基础', f: i => i.tags.includes('basic') || i.consumable === true },
  { id: 'boots', name: '鞋子', f: i => i.tags.includes('boots') },
  { id: 'ad', name: '攻击', f: i => (i.tags.includes('ad') || i.tags.includes('as') || i.tags.includes('crit')) && !i.tags.includes('basic') && !i.tags.includes('boots') },
  { id: 'ap', name: '法术', f: i => i.tags.includes('ap') && !i.tags.includes('basic') && !i.tags.includes('boots') },
  { id: 'tank', name: '防御', f: i => (i.tags.includes('tank') || i.tags.includes('support')) && !i.tags.includes('basic') && !i.tags.includes('boots') },
]

export class Hud {
  root: HTMLDivElement
  private q = <T extends HTMLElement = HTMLElement>(s: string) => this.root.querySelector(s) as T
  private announceQ: { text: string; sub?: string; color?: string }[] = []
  private announceUntil = 0
  private shopTab = 'rec'
  private shopSel: string | null = null
  private lastSlow = 0
  private tipFn: (() => string) | null = null
  private chatOpen = false
  fps = 0

  constructor(container: HTMLElement, private w: World, private act: HudActions, private info: { hostLabel: () => string; ping: () => string }) {
    this.root = el('div', 'hud')
    this.root.innerHTML = this.template()
    container.appendChild(this.root)
    this.bind()
    this.renderShop()
  }

  private template() {
    const me = this.w.me
    const sk = me ? me.def.skills.map((s, i) => `
      <div class="slot skill" data-key="${SKEYS[i]}" data-tip="skill:${i}">
        <div class="icon" style="--c:${champColor(me.def.color)}">${s.icon}</div>
        <div class="cdov"></div><div class="cdtxt"></div>
        <div class="kl">${SKEYS[i]}</div><div class="cost"></div>
        <div class="pips">${'<i></i>'.repeat(s.maxLv)}</div>
        <button class="lvlup" data-lv="${i}" title="升级技能 (Ctrl+${SKEYS[i]})">+</button>
      </div>`).join('') : ''
    const sp = me ? me.spells.map((id, i) => {
      const s = SPELL_MAP[id]
      const key = i ? 'F' : 'D'
      return `<div class="slot spell" data-key="${key}" data-tip="spell:${i}"><div class="icon">${s?.icon ?? '?'}</div><div class="cdov"></div><div class="cdtxt"></div><div class="kl">${key}</div></div>`
    }).join('') : ''
    const items = ITEM_KEYS.map((k, i) => `<div class="islot" data-slot="${i}" data-key="${k}" data-tip="item:${i}"><div class="icon"></div><div class="cdov"></div><div class="cdtxt"></div><div class="kl">${k}</div></div>`).join('')
    return `
      <div class="hud-top">
        <div class="team-score b"><span class="tk-b">0</span><small class="tw-b">🏰0</small></div>
        <div class="clock">00:00</div>
        <div class="team-score r"><span class="tk-r">0</span><small class="tw-r">🏰0</small></div>
      </div>
      <div class="hud-tr"><span class="kda">0/0/0</span><span class="cs">🗡 0</span><span class="fps"></span><span class="net"></span></div>
      <div class="killfeed"></div>
      <div class="announce"><div class="a-text"></div><div class="a-sub"></div></div>
      <div class="deathov hidden"><div class="d1">你已阵亡</div><div class="d2"></div></div>
      <div class="recallbar hidden"><div class="rb-label">回城</div><div class="rb-track"><div class="rb-fill"></div></div></div>
      <div class="castbar hidden"><div class="rb-track"><div class="rb-fill"></div></div></div>
      ${me ? `<div class="hud-bottom">
        <div class="portrait" data-tip="me">
          <div class="face" style="background:radial-gradient(circle at 40% 35%, ${champColor(me.def.color)}, ${champColor(me.def.color2)})">${esc(me.def.name[0])}</div>
          <svg class="xpring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" class="xp-bg"/><circle cx="50" cy="50" r="46" class="xp-fg"/></svg>
          <div class="lvl">1</div>
        </div>
        <div class="stats-mini">
          <div data-tip="stat:ad">⚔️<b class="st-ad"></b></div><div data-tip="stat:ap">🔮<b class="st-ap"></b></div>
          <div data-tip="stat:armor">🛡️<b class="st-ar"></b></div><div data-tip="stat:mr">✨<b class="st-mr"></b></div>
          <div data-tip="stat:as">🏹<b class="st-as"></b></div><div data-tip="stat:haste">⏱️<b class="st-cd"></b></div>
          <div data-tip="stat:crit">💥<b class="st-cr"></b></div><div data-tip="stat:ms">👟<b class="st-ms"></b></div>
        </div>
        <div class="center">
          <div class="buffs"></div>
          <div class="skills">${sk}<div class="gap"></div>${sp}</div>
          <div class="bars">
            <div class="bar hp"><div class="fill"></div><div class="shield"></div><span></span></div>
            <div class="bar mp"><div class="fill"></div><span></span></div>
          </div>
        </div>
        <div class="inv">
          <div class="items">${items}
            <div class="islot trinket" data-key="4" data-tip="ward"><div class="icon">👁️</div><div class="cdov"></div><div class="cdtxt"></div><div class="kl">4</div><div class="charges"></div></div>
          </div>
          <div class="inv-row">
            <button class="gold-btn" data-act="shop" title="商店 (P)">💰 <b class="gold">0</b></button>
            <button class="recall-btn" data-act="recall" title="回城 (B)">🏠</button>
          </div>
        </div>
      </div>` : `<div class="spec-banner">观战模式</div>`}
      <div class="chat"><div class="log"></div><input class="chat-in hidden" maxlength="120" placeholder="Enter 发送（Shift+Enter 发送给全部）"></div>
      <div class="tooltip hidden"></div>
      <div class="scoreboard hidden"></div>
      <div class="shop hidden">
        <div class="shop-head"><b>商店</b><span class="shop-hint"></span><button class="x" data-act="shop">✕</button></div>
        <div class="shop-tabs">${SHOP_TABS.map(t => `<button data-tab="${t.id}">${t.name}</button>`).join('')}</div>
        <div class="shop-body"><div class="shop-grid"></div><div class="shop-detail"></div></div>
      </div>
      <div class="gmenu hidden">
        <div class="gm-box">
          <h3>游戏菜单</h3>
          <label>音量 <input type="range" min="0" max="1" step="0.05" class="gm-vol"></label>
          <label>施法方式 <select class="gm-cast"><option value="quick">快速施法（按键即释放）</option><option value="indicator">指示器施法（松开释放）</option></select></label>
          <label><input type="checkbox" class="gm-edge"> 屏幕边缘移动镜头</label>
          <label><input type="checkbox" class="gm-fps"> 显示 FPS</label>
          <label><input type="checkbox" class="gm-shadow"> 阴影（重新进入生效）</label>
          <div class="gm-keys">右键 移动/攻击 · A+左键 攻击移动 · S 停止 · QWER 技能 · Ctrl+QWER 升级 · D/F 召唤师技能 · 1-7 物品 · 4 守卫 · B 回城 · P 商店 · Tab 数据 · 空格 镜头居中 · Y 锁定镜头 · G 标记信号 · Enter 聊天</div>
          <div class="gm-btns"><button data-act="resume">继续游戏</button><button class="danger" data-act="quit">退出对局</button></div>
        </div>
      </div>`
  }

  private bind() {
    const r = this.root
    r.addEventListener('mousedown', e => {
      const t = e.target as HTMLElement
      if (t.closest('.hud-bottom, .shop, .scoreboard, .gmenu, .chat')) e.stopPropagation()
    })
    r.addEventListener('contextmenu', e => e.preventDefault())
    r.addEventListener('click', e => {
      const t = e.target as HTMLElement
      const lv = t.closest('.lvlup') as HTMLElement | null
      if (lv) { this.act.levelSkill(Number(lv.dataset.lv)); sfx.play('click'); return }
      const slot = t.closest('.slot, .islot') as HTMLElement | null
      if (slot && !t.closest('.shop')) { this.act.cast(slot.dataset.key as CastKey); return }
      const a = t.closest('[data-act]') as HTMLElement | null
      if (a) {
        const act = a.dataset.act
        if (act === 'shop') this.toggleShop()
        else if (act === 'recall') this.act.recall()
        else if (act === 'resume') this.toggleMenu(false)
        else if (act === 'quit') this.act.quit()
        else if (act === 'buy') { this.act.buy(a.dataset.id!); this.renderShop() }
        else if (act === 'sell') { this.act.sell(Number(a.dataset.slot)); this.renderShop() }
        else if (act === 'sel') { this.shopSel = a.dataset.id!; this.renderShop() }
        return
      }
      const tab = t.closest('[data-tab]') as HTMLElement | null
      if (tab) { this.shopTab = tab.dataset.tab!; this.renderShop() }
    })
    r.addEventListener('dblclick', e => {
      const card = (e.target as HTMLElement).closest('.shop-item') as HTMLElement | null
      if (card) { this.act.buy(card.dataset.id!); this.renderShop() }
    })
    r.addEventListener('contextmenu', e => {
      const t = e.target as HTMLElement
      const card = t.closest('.shop-item') as HTMLElement | null
      if (card) { this.act.buy(card.dataset.id!); this.renderShop(); return }
      const is = t.closest('.islot') as HTMLElement | null
      if (is && is.dataset.slot && !this.q('.shop').classList.contains('hidden')) { this.act.sell(Number(is.dataset.slot)); this.renderShop() }
    })
    // tooltips
    r.addEventListener('mouseover', e => {
      const t = (e.target as HTMLElement).closest('[data-tip]') as HTMLElement | null
      if (!t) { this.hideTip(); return }
      const tip = t.dataset.tip!
      this.tipFn = () => this.tipHtml(tip)
      const tt = this.q('.tooltip')
      tt.innerHTML = this.tipFn()
      tt.classList.remove('hidden')
      const b = t.getBoundingClientRect()
      const tb = tt.getBoundingClientRect()
      tt.style.left = Math.max(8, Math.min(window.innerWidth - tb.width - 8, b.left + b.width / 2 - tb.width / 2)) + 'px'
      tt.style.top = Math.max(8, b.top - tb.height - 10) + 'px'
    })
    r.addEventListener('mouseout', e => {
      const t = (e.relatedTarget as HTMLElement | null)?.closest?.('[data-tip]')
      if (!t) this.hideTip()
    })
    // chat
    const input = this.q<HTMLInputElement>('.chat-in')
    input.addEventListener('keydown', e => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        const v = input.value.trim()
        if (v) this.act.chat(v, e.shiftKey)
        input.value = ''
        this.closeChat()
      } else if (e.key === 'Escape') this.closeChat()
    })
    // menu settings
    const vol = this.q<HTMLInputElement>('.gm-vol')
    vol.value = String(settings.volume)
    vol.addEventListener('input', () => { settings.volume = Number(vol.value); sfx.setVolume(settings.volume); saveSettings() })
    const cast = this.q<HTMLSelectElement>('.gm-cast')
    cast.value = settings.castMode
    cast.addEventListener('change', () => { settings.castMode = cast.value as any; saveSettings() })
    const edge = this.q<HTMLInputElement>('.gm-edge')
    edge.checked = settings.edgePan
    edge.addEventListener('change', () => { settings.edgePan = edge.checked; saveSettings() })
    const fps = this.q<HTMLInputElement>('.gm-fps')
    fps.checked = settings.showFps
    fps.addEventListener('change', () => { settings.showFps = fps.checked; saveSettings() })
    const sh = this.q<HTMLInputElement>('.gm-shadow')
    sh.checked = settings.shadows
    sh.addEventListener('change', () => { settings.shadows = sh.checked; saveSettings(); this.act.applySettings() })
  }

  private hideTip() {
    this.tipFn = null
    this.q('.tooltip').classList.add('hidden')
  }

  get chatting() { return this.chatOpen }
  openChat() {
    this.chatOpen = true
    const i = this.q<HTMLInputElement>('.chat-in')
    i.classList.remove('hidden')
    i.focus()
    this.root.querySelector('.chat')!.classList.add('open')
  }
  closeChat() {
    this.chatOpen = false
    const i = this.q<HTMLInputElement>('.chat-in')
    i.blur()
    i.classList.add('hidden')
    this.root.querySelector('.chat')!.classList.remove('open')
  }

  get shopOpen() { return !this.q('.shop').classList.contains('hidden') }
  toggleShop(v?: boolean) {
    const s = this.q('.shop')
    const show = v ?? s.classList.contains('hidden')
    s.classList.toggle('hidden', !show)
    if (show) this.renderShop()
    sfx.play('click')
  }
  get menuOpen() { return !this.q('.gmenu').classList.contains('hidden') }
  toggleMenu(v?: boolean) {
    const s = this.q('.gmenu')
    s.classList.toggle('hidden', !(v ?? s.classList.contains('hidden')))
  }
  closePanels() {
    if (this.chatOpen) { this.closeChat(); return true }
    if (this.shopOpen) { this.toggleShop(false); return true }
    return false
  }
  showScoreboard(v: boolean) {
    const s = this.q('.scoreboard')
    s.classList.toggle('hidden', !v)
    if (v) this.renderScoreboard()
  }

  // ------------------------------------------------------------------ feeds
  announce(text: string, sub?: string, color?: string) {
    this.announceQ.push({ text, sub, color })
    if (this.announceQ.length > 4) this.announceQ.shift()
  }

  killFeed(killer: Unit | null, victim: Unit) {
    const box = this.q('.killfeed')
    const face = (u: Unit | null) => {
      if (!u) return '<span class="kf-exec">处决</span>'
      if (u instanceof Champion) return `<span class="kf-face" style="background:${champColor(u.def.color)}">${esc(u.def.name[0])}</span><span class="kf-name">${esc(u.name)}</span>`
      return `<span class="kf-npc">${esc(u.name || '单位')}</span>`
    }
    const ally = this.w.spectator ? victim.team === 1 : victim.team !== this.w.myTeam
    const row = el('div', 'kf-row ' + (ally ? 'good' : 'bad'), `${face(killer)}<span class="kf-x">⚔</span>${face(victim)}`)
    box.prepend(row)
    while (box.children.length > 6) box.lastChild!.remove()
    setTimeout(() => { row.classList.add('fade'); setTimeout(() => row.remove(), 600) }, 9000)
  }

  chatLine(name: string, text: string, team: number, all: boolean, sys = false) {
    const log = this.q('.log')
    const cls = sys ? 'sys' : team === this.w.myTeam ? 'ally' : 'enemy'
    const row = el('div', 'cl ' + cls, sys ? esc(text) : `<b>${all ? '[全部] ' : ''}${esc(name)}:</b> ${esc(text)}`)
    log.appendChild(row)
    while (log.children.length > 40) log.firstChild!.remove()
    log.scrollTop = log.scrollHeight
    setTimeout(() => row.classList.add('old'), 12000)
  }

  // ------------------------------------------------------------------ per frame
  update(dt: number, nowMs: number) {
    const w = this.w
    const me = w.me
    // announcement
    const an = this.q('.announce')
    if (nowMs > this.announceUntil && this.announceQ.length) {
      const a = this.announceQ.shift()!
      ;(an.querySelector('.a-text') as HTMLElement).textContent = a.text
      ;(an.querySelector('.a-text') as HTMLElement).style.color = a.color ?? '#f0e6d2'
      ;(an.querySelector('.a-sub') as HTMLElement).textContent = a.sub ?? ''
      an.classList.remove('show')
      void an.offsetWidth
      an.classList.add('show')
      this.announceUntil = nowMs + 2600
    } else if (nowMs > this.announceUntil) an.classList.remove('show')

    if (me) this.updateMe(me, dt)
    const slow = nowMs - this.lastSlow > 200
    if (!slow) return
    this.lastSlow = nowMs
    this.q('.clock').textContent = fmtTime(w.time)
    const my = w.spectator ? 0 : w.myTeam
    this.q('.tk-b').textContent = String(w.teamKills[my as 0 | 1])
    this.q('.tk-r').textContent = String(w.teamKills[(1 - my) as 0 | 1])
    this.q('.tw-b').textContent = `🏰${w.towersKilled[my as 0 | 1]}  🐉${w.dragons[my as 0 | 1]}`
    this.q('.tw-r').textContent = `🏰${w.towersKilled[(1 - my) as 0 | 1]}  🐉${w.dragons[(1 - my) as 0 | 1]}`
    if (me) {
      this.q('.kda').textContent = `${me.kills}/${me.deaths}/${me.assists}`
      this.q('.cs').textContent = `🗡 ${me.cs}`
    }
    this.q('.fps').textContent = settings.showFps ? `FPS ${Math.round(this.fps)}` : ''
    this.q('.net').textContent = `${this.info.hostLabel()} ${this.info.ping()}`
    if (!this.q('.scoreboard').classList.contains('hidden')) this.renderScoreboard()
    if (this.tipFn) this.q('.tooltip').innerHTML = this.tipFn()
    if (this.shopOpen && me) {
      this.q('.shop-hint').textContent = me.canShop() ? `金币 ${Math.floor(me.gold)}` : '离开泉水后无法购买（阵亡时可购买）'
      this.q('.shop').classList.toggle('noshop', !me.canShop())
      this.markAffordable(me)
    }
  }

  private updateMe(me: Champion, dt: number) {
    const w = this.w
    // skills
    this.root.querySelectorAll<HTMLElement>('.slot').forEach(s => {
      const key = s.dataset.key as CastKey
      const lv = me.castLevel(key)
      const cd = me.cds[key] ?? 0
      const max = me.cdMax[key] || 1
      const cost = me.castCost(key)
      s.classList.toggle('unlearned', lv <= 0)
      s.classList.toggle('nomana', lv > 0 && me.mp < cost)
      s.classList.toggle('oncd', cd > 0)
      const ov = s.querySelector('.cdov') as HTMLElement
      const txt = s.querySelector('.cdtxt') as HTMLElement
      if (cd > 0) {
        const p = Math.round((cd / max) * 100)
        ov.style.background = `conic-gradient(rgba(5,8,14,0.78) ${p}%, rgba(5,8,14,0.15) ${p}%)`
        txt.textContent = cd >= 10 ? String(Math.ceil(cd)) : cd.toFixed(1)
      } else { ov.style.background = ''; txt.textContent = '' }
      const costEl = s.querySelector('.cost') as HTMLElement | null
      if (costEl) costEl.textContent = cost > 0 ? String(Math.round(cost)) : ''
      const i = SKEYS.indexOf(key)
      if (i >= 0) {
        const pips = s.querySelectorAll('.pips i')
        pips.forEach((p, n) => p.classList.toggle('on', n < me.skillLv[i]))
        const btn = s.querySelector('.lvlup') as HTMLElement
        const can = me.skillPoints > 0 && canLevel(me, i)
        btn.classList.toggle('show', can && !me.dead)
      }
    })
    // items
    this.root.querySelectorAll<HTMLElement>('.islot').forEach(s => {
      const key = s.dataset.key as CastKey
      if (key === '4') {
        ;(s.querySelector('.charges') as HTMLElement).textContent = String(me.wardCharges)
        s.classList.toggle('oncd', me.wardCharges <= 0)
        const txt = s.querySelector('.cdtxt') as HTMLElement
        txt.textContent = me.wardCharges <= 0 ? String(Math.ceil(me.wardRecharge)) : ''
        return
      }
      const idx = Number(s.dataset.slot)
      const id = me.items[idx]
      const icon = s.querySelector('.icon') as HTMLElement
      const want = id ? ITEM_MAP[id]?.icon ?? '?' : ''
      if (icon.textContent !== want) icon.textContent = want
      s.classList.toggle('empty', !id)
      const cd = me.cds[key] ?? 0
      const ov = s.querySelector('.cdov') as HTMLElement
      if (cd > 0 && id && ITEM_MAP[id]?.active) {
        const p = Math.round((cd / (me.cdMax[key] || 1)) * 100)
        ov.style.background = `conic-gradient(rgba(5,8,14,0.78) ${p}%, transparent ${p}%)`
        ;(s.querySelector('.cdtxt') as HTMLElement).textContent = String(Math.ceil(cd))
      } else { ov.style.background = ''; (s.querySelector('.cdtxt') as HTMLElement).textContent = '' }
    })
    // bars
    const hpFill = this.q('.bar.hp .fill'), shEl = this.q('.bar.hp .shield'), mpFill = this.q('.bar.mp .fill')
    const sh = me.shieldTotal()
    const tot = Math.max(me.maxHp, me.hp + sh)
    hpFill.style.width = (Math.max(0, me.hp) / tot) * 100 + '%'
    shEl.style.left = (Math.max(0, me.hp) / tot) * 100 + '%'
    shEl.style.width = (sh / tot) * 100 + '%'
    this.q('.bar.hp span').textContent = `${Math.max(0, Math.ceil(me.hp))} / ${Math.round(me.maxHp)}` + (me.stats.hpRegen > 0 ? `  +${me.stats.hpRegen.toFixed(1)}` : '')
    mpFill.style.width = (me.maxMp > 0 ? (me.mp / me.maxMp) * 100 : 0) + '%'
    this.q('.bar.mp span').textContent = `${Math.floor(me.mp)} / ${Math.round(me.maxMp)}`
    this.q('.lvl').textContent = String(me.level)
    const need = xpToNext(me.level)
    const xpk = me.level >= 18 ? 1 : me.xp / need
    ;(this.q('.xp-fg') as unknown as SVGCircleElement).style.strokeDashoffset = String(289 * (1 - xpk))
    this.q('.gold').textContent = String(Math.floor(me.gold))
    const s = me.stats
    this.q('.st-ad').textContent = String(Math.round(s.ad))
    this.q('.st-ap').textContent = String(Math.round(s.ap))
    this.q('.st-ar').textContent = String(Math.round(s.armor))
    this.q('.st-mr').textContent = String(Math.round(s.mr))
    this.q('.st-as').textContent = s.as.toFixed(2)
    this.q('.st-cd').textContent = String(Math.round(s.haste))
    this.q('.st-cr').textContent = Math.round(s.crit * 100) + '%'
    this.q('.st-ms').textContent = String(Math.round(me.moveSpeed() * 70))
    // death
    const dov = this.q('.deathov')
    dov.classList.toggle('hidden', !me.dead)
    if (me.dead) this.q('.d2').textContent = `${Math.ceil(Math.max(0, me.respawnAt - w.now))} 秒后复活`
    // recall bar
    const rb = this.q('.recallbar')
    if (me.recallAt >= 0 && !me.dead) {
      rb.classList.remove('hidden')
      ;(rb.querySelector('.rb-fill') as HTMLElement).style.width = Math.min(100, ((w.now - me.recallAt) / me.recallDur) * 100) + '%'
    } else rb.classList.add('hidden')
    const cb = this.q('.castbar')
    if (me.casting && me.casting.until - w.now > 0.15) {
      cb.classList.remove('hidden')
      const def = me.castDef(me.casting.key)
      const tot = def?.castTime || 1
      ;(cb.querySelector('.rb-fill') as HTMLElement).style.width = Math.min(100, (1 - (me.casting.until - w.now) / tot) * 100) + '%'
    } else cb.classList.add('hidden')
    // buffs
    const bb = this.q('.buffs')
    const icons: string[] = []
    const now = w.now
    for (const b of me.buffs) {
      const ic = BUFF_ICON[b.kind]
      if (!ic) continue
      const rem = b.until - now
      icons.push(`<span class="buff ${BAD.has(b.kind) ? 'bad' : ''}" title="${BUFF_NAME[b.kind] ?? b.kind}">${ic}${b.kind === 'dragon' ? `<i>${b.value}</i>` : rem < 60 ? `<i>${Math.ceil(rem)}</i>` : ''}</span>`)
    }
    const html = icons.join('')
    if (bb.innerHTML !== html) bb.innerHTML = html
    void dt
  }

  // ------------------------------------------------------------------ tooltips
  private tipHtml(tip: string): string {
    const me = this.w.me
    if (!me) return ''
    const [kind, arg] = tip.split(':')
    if (kind === 'skill') {
      const i = Number(arg)
      const s = me.def.skills[i]
      const lv = Math.max(1, me.skillLv[i])
      const cd = s.cd[lv - 1] * (100 / (100 + me.stats.haste))
      return `<div class="tt-h">${s.icon} ${esc(s.name)} <small>[${SKEYS[i]}] 等级 ${me.skillLv[i]}/${s.maxLv}</small></div>
        <div class="tt-m">冷却 ${cd.toFixed(1)}秒 · 消耗 ${s.cost[lv - 1]} 法力 · 距离 ${s.range}</div>
        <div class="tt-d">${esc(s.desc(lv, me))}</div>${i === 3 ? '<div class="tt-m">大招在 11/16 级可升级</div>' : ''}`
    }
    if (kind === 'spell') {
      const sp = SPELL_MAP[me.spells[Number(arg)]]
      return sp ? `<div class="tt-h">${sp.icon} ${esc(sp.name)} <small>冷却 ${sp.cd}秒</small></div><div class="tt-d">${esc(sp.desc)}</div>` : ''
    }
    if (kind === 'item') {
      const id = me.items[Number(arg)]
      if (!id) return '<div class="tt-d">空装备栏</div>'
      return itemTip(ITEM_MAP[id], me)
    }
    if (kind === 'ward') return `<div class="tt-h">👁️ 侦查守卫 <small>[4]</small></div><div class="tt-d">放置一个守卫，提供90秒视野。最多储存2次，每60秒充能一次。当前充能：${me.wardCharges}</div>`
    if (kind === 'me') {
      const need = xpToNext(me.level)
      return `<div class="tt-h">${esc(me.def.name)} · ${esc(me.def.title)}</div><div class="tt-m">${me.def.role} · 等级 ${me.level} · 经验 ${Math.floor(me.xp)}/${need}</div><div class="tt-d">${esc(me.def.lore)}</div>`
    }
    if (kind === 'stat') {
      const names: Record<string, string> = { ad: '攻击力', ap: '法术强度', armor: '护甲', mr: '魔法抗性', as: '攻击速度', haste: '技能急速', crit: '暴击几率', ms: '移动速度' }
      return `<div class="tt-h">${names[arg] ?? arg}</div>`
    }
    return ''
  }

  // ------------------------------------------------------------------ shop
  renderShop() {
    const me = this.w.me
    if (!me) return
    const tabs = this.root.querySelectorAll<HTMLElement>('.shop-tabs button')
    tabs.forEach(b => b.classList.toggle('on', b.dataset.tab === this.shopTab))
    const tab = SHOP_TABS.find(t => t.id === this.shopTab)!
    const list = this.shopTab === 'rec' ? [...me.def.build.map(id => ITEM_MAP[id]), ITEM_MAP.potion] : ITEMS.filter(tab.f)
    this.q('.shop-grid').innerHTML = list.map(it => `
      <div class="shop-item ${me.hasItem(it.id) && !it.consumable ? 'owned' : ''} ${this.shopSel === it.id ? 'sel' : ''}" data-act="sel" data-id="${it.id}">
        <div class="si-icon">${it.icon}</div><div class="si-name">${esc(it.name)}</div><div class="si-price" data-price="${it.price}">${it.price}</div>
      </div>`).join('')
    const sel = this.shopSel ? ITEM_MAP[this.shopSel] : null
    const inv = me.items.map((id, i) => id ? `<div class="inv-it"><span>${ITEM_MAP[id].icon} ${esc(ITEM_MAP[id].name)}</span><button data-act="sell" data-slot="${i}">出售 ${Math.floor(ITEM_MAP[id].price * SELL_RATIO)}</button></div>` : '').join('')
    this.q('.shop-detail').innerHTML = (sel ? `${itemTip(sel, me)}<button class="buy-btn" data-act="buy" data-id="${sel.id}">购买 · ${sel.price} 金币</button>` : '<div class="tt-d">选择一件装备查看详情<br>右键或双击装备可直接购买</div>') +
      `<div class="inv-list"><div class="tt-m">我的装备（右键装备栏可出售）</div>${inv || '<div class="tt-d">暂无</div>'}</div>`
    this.markAffordable(me)
  }
  private markAffordable(me: Champion) {
    this.root.querySelectorAll<HTMLElement>('.si-price').forEach(p => p.classList.toggle('poor', Number(p.dataset.price) > me.gold))
  }

  // ------------------------------------------------------------------ scoreboard
  renderScoreboard() {
    const w = this.w
    const teams = [0, 1].map(t => w.champs.filter(c => c.team === t))
    const row = (c: Champion) => `
      <tr class="${c === w.me ? 'me' : ''} ${c.dead ? 'dead' : ''}">
        <td><span class="sb-face" style="background:${champColor(c.def.color)}">${esc(c.def.name[0])}</span></td>
        <td class="sb-name">${esc(c.name)}${c.isBot ? ' <small>AI</small>' : ''}<br><small>${esc(c.def.name)} · Lv${c.level}${c.dead ? ` · ${Math.ceil(c.respawnRemain || Math.max(0, c.respawnAt - w.now))}s` : ''}</small></td>
        <td class="sb-kda">${c.kills}/${c.deaths}/${c.assists}</td>
        <td>${c.cs}</td>
        <td class="sb-items">${c.items.map(id => `<span>${id ? ITEM_MAP[id]?.icon ?? '' : ''}</span>`).join('')}</td>
        <td>${c.team === w.myTeam || w.spectator ? Math.floor(c.gold) : '—'}</td>
      </tr>`
    this.q('.scoreboard').innerHTML = [0, 1].map(t => `
      <div class="sb-team t${t}"><div class="sb-head">${t === 0 ? '蓝色方' : '红色方'} · 击杀 ${w.teamKills[t]} · 🏰 ${w.towersKilled[t]} · 🐉 ${w.dragons[t]} · 👾 ${w.barons[t]}</div>
      <table><tr><th></th><th>玩家</th><th>K/D/A</th><th>补刀</th><th>装备</th><th>金币</th></tr>${teams[t].map(row).join('')}</table></div>`).join('')
  }

  destroy() {
    this.root.remove()
  }
}

export function canLevel(me: Champion, i: number) {
  return canUpgradeSkill(me.level, me.skillLv[i], i)
}

export function itemTip(it: ItemDef, me?: Champion) {
  return `<div class="tt-h">${it.icon} ${esc(it.name)} <small class="gold-t">${it.price} 金币</small></div>
    <div class="tt-s">${esc(statLine(it.stats))}</div>
    ${it.passive ? `<div class="tt-d">被动：${esc(it.passive)}</div>` : ''}
    ${it.active ? `<div class="tt-d">主动 - ${esc(it.active.name)}：${esc(it.active.desc)}（冷却 ${it.active.cd}秒）</div>` : ''}
    ${it.consumable ? '<div class="tt-m">消耗品，使用后消失</div>' : ''}
    ${me && me.hasItem(it.id) && !it.consumable ? '<div class="tt-m">已拥有</div>' : ''}`
}

const BUFF_ICON: Partial<Record<string, string>> = {
  stun: '💫', root: '⛓️', silence: '🔇', slow: '🐌', knockup: '🌪️', stealth: '🌑', shield: '🛡️', dr: '🗿', ms: '💨', as: '⚡',
  burn: '🔥', stasis: '⏳', blue: '🔵', red: '🔴', baron: '👾', dragon: '🐉', regen: '🧪', grievous: '💔', empower: '✴️', spin: '🌪️',
}
const BUFF_NAME: Partial<Record<string, string>> = {
  stun: '眩晕', root: '禁锢', silence: '沉默', slow: '减速', knockup: '击飞', stealth: '隐身', shield: '护盾', dr: '减伤', ms: '加速', as: '攻速提升',
  burn: '灼烧', stasis: '凝滞', blue: '蓝BUFF：技能急速+15，法力回复', red: '红BUFF：普攻灼烧减速，生命回复', baron: '男爵之手', dragon: '巨龙之力', regen: '生命药水', grievous: '重伤', empower: '强化普攻', spin: '旋转中',
}
const BAD = new Set(['stun', 'root', 'silence', 'slow', 'knockup', 'burn', 'grievous'])
export const unusedF = F
