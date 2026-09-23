import { SimplePool } from 'nostr-tools/pool'
import type { Event, Filter } from 'nostr-tools'
import { APP_KIND, APP_TAG, MATCH_D_PREFIX, NOSTR_RELAYS, STATS_D } from '../config'
import { identity, sign } from './identity'

let pool: SimplePool | null = null
function P() {
  return (pool ??= new SimplePool({ enablePing: false, enableReconnect: false } as any))
}

export async function publish(tpl: { kind: number; tags: string[][]; content: string }): Promise<{ ok: number; fail: number; event: Event }> {
  const ev = await sign({ ...tpl, created_at: Math.floor(Date.now() / 1000) })
  const results = await Promise.allSettled(P().publish(NOSTR_RELAYS, ev, { maxWait: 6000 }))
  const ok = results.filter(r => r.status === 'fulfilled').length
  return { ok, fail: results.length - ok, event: ev }
}

export async function query(filter: Filter, maxWait = 4500): Promise<Event[]> {
  try {
    const evs = await P().querySync(NOSTR_RELAYS, filter, { maxWait })
    const seen = new Map<string, Event>()
    for (const e of evs) {
      // keep latest per (pubkey, d) for replaceable events
      const d = e.tags.find(t => t[0] === 'd')?.[1] ?? e.id
      const key = e.kind >= 30000 ? e.pubkey + ':' + d : e.id
      const prev = seen.get(key)
      if (!prev || prev.created_at < e.created_at) seen.set(key, e)
    }
    return [...seen.values()]
  } catch (e) {
    console.warn('nostr query failed', e)
    return []
  }
}

// ------------------------------------------------------------ profile (kind 0)
export async function publishProfile(name: string) {
  return publish({ kind: 0, tags: [], content: JSON.stringify({ name, display_name: name, about: '星核峡谷 Nexus Rift 玩家' }) })
}

// ------------------------------------------------------------ stats (NIP-78 app data)
export interface PlayerStats {
  name: string
  games: number
  wins: number
  losses: number
  kills: number
  deaths: number
  assists: number
  cs: number
  rating: number
  champs: Record<string, { g: number; w: number }>
  streak: number
  updatedAt: number
}

export const emptyStats = (name: string): PlayerStats => ({
  name, games: 0, wins: 0, losses: 0, kills: 0, deaths: 0, assists: 0, cs: 0, rating: 1000, champs: {}, streak: 0, updatedAt: 0,
})

const LS_STATS = () => 'nexusrift.stats.' + identity().pk

export function localStats(): PlayerStats | null {
  try {
    const raw = localStorage.getItem(LS_STATS())
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
function saveLocalStats(s: PlayerStats) {
  localStorage.setItem(LS_STATS(), JSON.stringify(s))
}

function parseStats(e: Event): PlayerStats | null {
  try {
    const s = JSON.parse(e.content)
    if (typeof s.games !== 'number') return null
    return { ...emptyStats(s.name ?? ''), ...s }
  } catch { return null }
}

export async function fetchMyStats(): Promise<PlayerStats> {
  const id = identity()
  const local = localStats()
  const evs = await query({ kinds: [APP_KIND], authors: [id.pk], '#d': [STATS_D] })
  const remote = evs.map(parseStats).filter(Boolean) as PlayerStats[]
  let best = local
  for (const r of remote) if (!best || r.games > best.games || (r.games === best.games && r.updatedAt > best.updatedAt)) best = r
  const s = best ?? emptyStats(id.name)
  saveLocalStats(s)
  return s
}

export interface MatchRecord {
  id: string
  map: string
  mode: string
  duration: number
  endedAt: number
  win: boolean
  team: number
  champ: string
  k: number
  d: number
  a: number
  cs: number
  level: number
  gold: number
  items: (string | null)[]
  bots: boolean
  players: { n: string; pk?: string; c: string; t: number; k: number; d: number; a: number; bot?: boolean }[]
}

export async function recordMatch(rec: MatchRecord): Promise<{ stats: PlayerStats; published: number }> {
  const id = identity()
  let s = localStats() ?? (await fetchMyStats().catch(() => emptyStats(id.name)))
  s = { ...s, name: id.name }
  s.games++
  if (rec.win) { s.wins++; s.streak = Math.max(1, s.streak + 1) } else { s.losses++; s.streak = Math.min(-1, s.streak - 1) }
  s.kills += rec.k; s.deaths += rec.d; s.assists += rec.a; s.cs += rec.cs
  const delta = rec.bots && rec.players.filter(p => !p.bot).length <= 1 ? (rec.win ? 8 : -5) : rec.win ? 25 : -18
  s.rating = Math.max(0, s.rating + delta)
  const ch = (s.champs[rec.champ] ??= { g: 0, w: 0 })
  ch.g++
  if (rec.win) ch.w++
  s.updatedAt = Date.now()
  saveLocalStats(s)
  let published = 0
  try {
    const humans = rec.players.filter(p => p.pk && p.pk !== id.pk).map(p => ['p', p.pk!])
    const r1 = await publish({
      kind: APP_KIND,
      tags: [['d', MATCH_D_PREFIX + rec.id], ['t', APP_TAG + '-match'], ['r', rec.win ? 'win' : 'loss'], ...humans.slice(0, 9)],
      content: JSON.stringify(rec),
    })
    const r2 = await publish({ kind: APP_KIND, tags: [['d', STATS_D], ['t', APP_TAG + '-stats']], content: JSON.stringify(s) })
    published = Math.min(r1.ok, r2.ok)
  } catch (e) { console.warn('publish failed', e) }
  return { stats: s, published }
}

export async function republishStats(name: string) {
  const s = localStats()
  if (!s) return
  s.name = name
  saveLocalStats(s)
  try { await publish({ kind: APP_KIND, tags: [['d', STATS_D], ['t', APP_TAG + '-stats']], content: JSON.stringify(s) }) } catch { /* ignore */ }
}

export async function fetchMyMatches(limit = 30): Promise<MatchRecord[]> {
  const id = identity()
  const evs = await query({ kinds: [APP_KIND], authors: [id.pk], '#t': [APP_TAG + '-match'], limit })
  const out: MatchRecord[] = []
  for (const e of evs) { try { out.push(JSON.parse(e.content)) } catch { /* skip */ } }
  return out.sort((a, b) => b.endedAt - a.endedAt)
}

export interface LeaderRow extends PlayerStats { pk: string }
export async function fetchLeaderboard(limit = 300): Promise<LeaderRow[]> {
  const evs = await query({ kinds: [APP_KIND], '#t': [APP_TAG + '-stats'], limit }, 5000)
  const rows: LeaderRow[] = []
  for (const e of evs) {
    const s = parseStats(e)
    if (!s || s.games <= 0) continue
    rows.push({ ...s, pk: e.pubkey })
  }
  const mine = localStats()
  const me = identity()
  if (mine && mine.games > 0 && !rows.some(r => r.pk === me.pk)) rows.push({ ...mine, pk: me.pk })
  return rows.sort((a, b) => b.rating - a.rating || b.wins - a.wins)
}
