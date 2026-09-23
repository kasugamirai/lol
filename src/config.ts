export const APP_NAME = '星核峡谷'
export const APP_VERSION = 1
/** Yjs sync relay (y-websocket protocol). Actual url: `${YJS_URL}/<room>?token=${YJS_TOKEN}` */
export const YJS_URL = 'wss://ws.flow.plateau.reearth.io'
export const YJS_TOKEN = 'netdisk'
export const LOBBY_ROOM = 'nexusrift-lobby-v1'
export const ROOM_PREFIX = 'nexusrift-room-v1-'

export const NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://yabu.me',
  'wss://relay.nostr.wirednet.jp',
  'wss://nostr.mom',
  'wss://offchain.pub',
]
/** NIP-78 application data */
export const APP_KIND = 30078
export const APP_TAG = 'nexusrift'
export const STATS_D = 'nexusrift:stats'
export const MATCH_D_PREFIX = 'nexusrift:match:'

/** separate identities per tab for local testing: ?id=alice */
export const PROFILE_SUFFIX = (() => {
  try {
    const p = new URLSearchParams(location.search).get('id')
    return p ? ':' + p.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) : ''
  } catch { return '' }
})()
