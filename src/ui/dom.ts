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

export function modal(html: string, opts: { onClose?: () => void; cls?: string } = {}) {
  const bg = el('div', 'modal-bg')
  const box = el('div', 'modal ' + (opts.cls ?? ''), html)
  bg.appendChild(box)
  document.body.appendChild(bg)
  const close = () => { bg.remove(); opts.onClose?.() }
  bg.addEventListener('mousedown', e => { if (e.target === bg) close() })
  box.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close))
  return { box, close }
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
  return `<div class="avatar" style="width:${size}px;height:${size}px;background:linear-gradient(135deg, ${hueColor(hue, 60, 45)}, ${hueColor(hue + 40, 60, 25)});font-size:${Math.round(size * 0.45)}px">${ch}</div>`
}

export function champColor(c: number) {
  return '#' + c.toString(16).padStart(6, '0')
}

export function copyText(t: string) {
  try {
    navigator.clipboard.writeText(t)
    toast('已复制到剪贴板', 'ok')
  } catch {
    toast('复制失败，请手动复制', 'err')
  }
}
