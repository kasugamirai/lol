import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type { Awareness } from 'y-protocols/awareness'
import { YJS_TOKEN, YJS_URL } from '../config'

export type ConnStatus = 'connecting' | 'connected' | 'disconnected'

/** Thin wrapper over a y-websocket room on the shared relay. */
export class YRoom {
  readonly doc = new Y.Doc()
  readonly provider: WebsocketProvider
  status: ConnStatus = 'connecting'
  synced = false
  private statusCbs = new Set<(s: ConnStatus) => void>()
  private destroyed = false

  constructor(public readonly name: string) {
    this.provider = new WebsocketProvider(YJS_URL, name, this.doc, {
      params: { token: YJS_TOKEN },
      disableBc: true,
      maxBackoffTime: 4000,
    })
    this.provider.on('status', (e: { status: ConnStatus }) => {
      this.status = e.status
      for (const cb of this.statusCbs) cb(e.status)
    })
    this.provider.on('sync', (s: boolean) => { this.synced = s })
  }

  get awareness(): Awareness {
    return this.provider.awareness
  }
  get clientId() {
    return this.doc.clientID
  }

  onStatus(cb: (s: ConnStatus) => void) {
    this.statusCbs.add(cb)
    return () => this.statusCbs.delete(cb)
  }

  whenSynced(timeoutMs = 6000): Promise<boolean> {
    if (this.synced) return Promise.resolve(true)
    return new Promise(res => {
      const t = setTimeout(() => { this.provider.off('sync', h); res(false) }, timeoutMs)
      const h = (s: boolean) => {
        if (!s) return
        clearTimeout(t)
        this.provider.off('sync', h)
        res(true)
      }
      this.provider.on('sync', h)
    })
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    try { this.awareness.setLocalState(null) } catch { /* ignore */ }
    this.provider.destroy()
    this.doc.destroy()
  }
}
