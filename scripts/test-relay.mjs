import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import WebSocket from 'ws'

const URL = 'wss://ws.flow.plateau.reearth.io'
const room = 'nexus-rift-test-' + Math.random().toString(36).slice(2, 8)

function mk(name) {
  const doc = new Y.Doc()
  const p = new WebsocketProvider(URL, room, doc, { WebSocketPolyfill: WebSocket, params: { token: 'netdisk' }, disableBc: true })
  p.on('status', e => console.log(name, 'status', e.status))
  return { doc, p }
}

const a = mk('A')
const b = mk('B')
const t0 = Date.now()
await new Promise(r => { let n = 0; const f = () => { if (++n === 2) r() }; a.p.once('sync', f); b.p.once('sync', f) })
console.log('both synced in', Date.now() - t0, 'ms; url=', a.p.url)

// doc sync latency
const lat = []
b.doc.getMap('m').observe(e => { const v = b.doc.getMap('m').get('t'); lat.push(Date.now() - v) })
for (let i = 0; i < 5; i++) { a.doc.getMap('m').set('t', Date.now()); await new Promise(r => setTimeout(r, 200)) }
console.log('doc latencies', lat)

// awareness relay
const alat = []
b.p.awareness.on('change', ({ updated, added }) => {
  for (const id of [...updated, ...added]) {
    if (id === a.doc.clientID) { const s = b.p.awareness.getStates().get(id); if (s?.t) alat.push(Date.now() - s.t) }
  }
})
for (let i = 0; i < 10; i++) { a.p.awareness.setLocalState({ t: Date.now(), big: 'x'.repeat(3000) }); await new Promise(r => setTimeout(r, 50)) }
await new Promise(r => setTimeout(r, 1000))
console.log('awareness latencies', alat)
// rapid-fire awareness: 60 updates at ~16ms
let recv = 0
b.p.awareness.on('update', ({ updated }) => { if (updated.includes(a.doc.clientID)) recv++ })
for (let i = 0; i < 60; i++) { a.p.awareness.setLocalState({ t: Date.now(), i }); await new Promise(r => setTimeout(r, 16)) }
await new Promise(r => setTimeout(r, 1500))
console.log('rapid awareness received', recv, 'of 60; final i=', b.p.awareness.getStates().get(a.doc.clientID)?.i)
a.p.destroy(); b.p.destroy()
process.exit(0)
