import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay'
import WebSocket from 'ws'
useWebSocketImplementation(WebSocket)

const relays = ['wss://relay.damus.io','wss://nos.lol','wss://relay.primal.net','wss://relay.nostr.band','wss://relay.snort.social','wss://nostr.mom','wss://offchain.pub','wss://relay.nostr.net','wss://nostr.oxtr.dev','wss://relay.nostr.wirednet.jp','wss://yabu.me']
const sk = generateSecretKey(); const pk = getPublicKey(sk)
const ev = finalizeEvent({ kind: 30078, created_at: Math.floor(Date.now()/1000), tags: [['d','nexus-rift-test:stats'],['t','nexus-rift-test']], content: JSON.stringify({wins:1}) }, sk)
await Promise.all(relays.map(async url => {
  const t0 = Date.now()
  try {
    const r = await Promise.race([Relay.connect(url), new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout')), 6000))])
    const tc = Date.now() - t0
    let pub = 'ok'
    try { await Promise.race([r.publish(ev), new Promise((_, rej) => setTimeout(() => rej(new Error('pub timeout')), 6000))]) } catch (e) { pub = 'ERR ' + e.message }
    // query back
    const got = await new Promise(res => {
      let found = 0
      const sub = r.subscribe([{ kinds: [30078], authors: [pk] }], { onevent() { found++ }, oneose() { sub.close(); res(found) } })
      setTimeout(() => res('timeout'), 5000)
    })
    const q2 = await new Promise(res => {
      let n = 0
      const sub = r.subscribe([{ kinds: [30078], '#t': ['nexus-rift-test'], limit: 10 }], { onevent() { n++ }, oneose() { sub.close(); res(n) } })
      setTimeout(() => res('timeout'), 5000)
    })
    console.log(url.padEnd(34), 'connect', tc + 'ms', '| publish:', pub, '| readback:', got, '| #t query:', q2)
    r.close()
  } catch (e) { console.log(url.padEnd(34), 'FAIL', e.message) }
}))
process.exit(0)
