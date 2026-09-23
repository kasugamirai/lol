export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html !== undefined) e.innerHTML = html
  return e
}

/** event delegation on [data-act] */
export function onAct(root: HTMLElement, handlers: Record<string, (el: HTMLElement, ev: Event) => void>, events: string[] = ['click']) {
  const fn = (ev: Event) => {
    const t = (ev.target as HTMLElement | null)?.closest?.('[data-act]') as HTMLElement | null
    if (!t || !root.contains(t)) return
    const act = t.dataset.act!
    const h = handlers[act]
    if (h) h(t, ev)
  }
  for (const e of events) root.addEventListener(e, fn)
  return () => { for (const e of events) root.removeEventListener(e, fn) }
}

let toastBox: HTMLDivElement | null = null
export function toast(msg: string, kind: 'info' | 'ok' | 'err' = 'info', ms = 2600) {
  if (!toastBox) {
    toastBox = el('div', 'toasts')
    document.body.appendChild(toastBox)
  }
  const t = el('div', 'toast toast-' + kind, esc(msg))
  toastBox.appendChild(t)
  requestAnimationFrame(() => t.classList.add('show'))
  setTimeout(() => {
    t.classList.remove('show')
    setTimeout(() => t.remove(), 300)
  }, ms)
}

/** dispatched on document whenever a modal opens (main.ts re-arms the mobile back-button sentinel) */
export const MODAL_OPEN_EVENT = 'nr-modal-open'

interface OpenModal { close: () => void; dismissable: boolean }
/** open modals, topmost last */
const modalStack: OpenModal[] = []

export function modal(html: string, opts: { onClose?: () => void; cls?: string; dismissable?: boolean } = {}) {
  const dismissable = opts.dismissable !== false
  const bg = el('div', 'modal-bg')
  const box = el('div', 'modal ' + (opts.cls ?? ''), html)
  if (dismissable) box.insertAdjacentHTML('afterbegin', '<button class="modal-x" data-close aria-label="关闭">✕</button>')
  bg.appendChild(box)
  document.body.appendChild(bg)
  let closed = false
  const entry: OpenModal = { close: () => close(), dismissable }
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.isComposing || modalStack[modalStack.length - 1] !== entry) return
    // capture phase on document: the game's window keydown handler never sees this Escape
    e.stopPropagation()
    e.preventDefault()
    if (dismissable) close()
  }
  const close = () => {
    if (closed) return
    closed = true
    bg.remove()
    document.removeEventListener('keydown', onKey, true)
    const i = modalStack.indexOf(entry)
    if (i >= 0) modalStack.splice(i, 1)
    opts.onClose?.()
  }
  modalStack.push(entry)
  document.addEventListener('keydown', onKey, true)
  // keys typed inside the modal (inputs) must not reach window-level hotkeys
  box.addEventListener('keydown', e => e.stopPropagation())
  if (dismissable) {
    // close on a full tap/click on the backdrop only (a drag that ends outside the box does not count)
    let downBg = false
    bg.addEventListener('pointerdown', e => { downBg = e.target === bg })
    bg.addEventListener('click', e => { if (downBg && e.target === bg) close(); downBg = false })
  }
  box.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close))
  document.dispatchEvent(new Event(MODAL_OPEN_EVENT))
  return { box, close }
}

/** close the topmost modal (Android back button); true if a modal was open */
export function closeTopModal(): boolean {
  const top = modalStack[modalStack.length - 1]
  if (!top) return false
  if (top.dismissable) top.close()
  return true
}

/** in-page replacement for confirm(); resolves false when dismissed */
export function confirmModal(text: string, okLabel = '确定', danger = false): Promise<boolean> {
  return new Promise(resolve => {
    let ok = false
    const m = modal(`<p class="cm-text">${esc(text)}</p>
      <div class="modal-btns"><button class="btn" data-close>取消</button><button class="${danger ? 'btn danger' : 'btn-gold'}" data-ok>${esc(okLabel)}</button></div>`,
    { cls: 'confirm-modal', onClose: () => resolve(ok) })
    const b = m.box.querySelector('[data-ok]') as HTMLButtonElement
    b.addEventListener('click', () => { ok = true; m.close() })
    if (!danger) b.focus()
  })
}

/** in-page replacement for prompt(); resolves null when cancelled */
export function promptModal(title: string, value: string, maxlength = 64): Promise<string | null> {
  return new Promise(resolve => {
    let out: string | null = null
    const m = modal(`<h3>${esc(title)}</h3>
      <input class="pm-in" maxlength="${maxlength}" value="${esc(value)}" enterkeyhint="done" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
      <div class="modal-btns"><button class="btn" data-close>取消</button><button class="btn-gold" data-ok>确定</button></div>`,
    { cls: 'prompt-modal', onClose: () => resolve(out) })
    const inp = m.box.querySelector('.pm-in') as HTMLInputElement
    const submit = () => { out = inp.value; m.close() }
    m.box.querySelector('[data-ok]')!.addEventListener('click', submit)
    inp.addEventListener('keydown', e => {
      // IME: the Enter that commits a composition must not submit
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return
      e.preventDefault()
      submit()
    })
    inp.focus()
    inp.select()
  })
}

export function fmtTime(sec: number) {
  sec = Math.max(0, Math.floor(sec))
  const m = Math.floor(sec / 60), s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function hueColor(h: number, s = 55, l = 50) {
  return `hsl(${h}, ${s}%, ${l}%)`
}

export function avatarHtml(name: string, hue: number, size = 44) {
  const ch = esc((name || '?').slice(0, 1))
  // size via --sz so responsive CSS can shrink avatars (see .avatar in styles.css)
  return `<div class="avatar" style="--sz:${size}px;background:linear-gradient(135deg, ${hueColor(hue, 60, 45)}, ${hueColor(hue + 40, 60, 25)})">${ch}</div>`
}

export function champColor(c: number) {
  return '#' + c.toString(16).padStart(6, '0')
}

export function copyText(t: string) {
  const ok = () => toast('已复制到剪贴板', 'ok')
  const fail = () => toast('复制失败，请手动复制', 'err')
  // execCommand fallback: insecure origins (LAN http), older iOS, or a rejected clipboard permission
  const fallback = () => {
    try {
      const ta = el('textarea')
      ta.value = t
      ta.setAttribute('readonly', '')
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
      document.body.appendChild(ta)
      ta.select()
      ta.setSelectionRange(0, t.length)
      const done = document.execCommand('copy')
      ta.remove()
      if (done) ok()
      else fail()
    } catch { fail() }
  }
  try {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(ok, fallback)
    else fallback()
  } catch { fallback() }
}
