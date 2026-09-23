import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, type EventTemplate, type Event } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { PROFILE_SUFFIX } from '../config'

export type LoginMethod = 'auto' | 'nsec' | 'nip07'

export interface Identity {
  pk: string
  npub: string
  method: LoginMethod
  name: string
  avatar: number // avatar color seed
  createdAt: number
}

interface Stored {
  method: LoginMethod
  sk?: string
  pk: string
  name: string
  avatar: number
  createdAt: number
}

const KEY = 'nexusrift.identity' + PROFILE_SUFFIX
let current: Identity | null = null
let secret: Uint8Array | null = null

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>
      signEvent(e: EventTemplate): Promise<Event>
    }
  }
}

function randomName() {
  const a = ['疾风', '烈焰', '寒霜', '雷霆', '暗影', '星辰', '磐石', '苍穹', '赤月', '碧海', '银翼', '幻影']
  const b = ['召唤师', '剑客', '游侠', '法师', '守卫', '猎手', '骑士', '术士']
  return a[Math.floor(Math.random() * a.length)] + b[Math.floor(Math.random() * b.length)] + Math.floor(100 + Math.random() * 900)
}

function save(s: Stored) {
  localStorage.setItem(KEY, JSON.stringify(s))
}
function load(): Stored | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Stored) : null
  } catch { return null }
}

function toIdentity(s: Stored): Identity {
  return { pk: s.pk, npub: nip19.npubEncode(s.pk), method: s.method, name: s.name, avatar: s.avatar, createdAt: s.createdAt }
}

/** Load the saved identity or silently create a fresh Nostr keypair. */
export function loadIdentity(): { id: Identity; created: boolean } {
  const s = load()
  if (s && s.pk) {
    if (s.sk) secret = hexToBytes(s.sk)
    current = toIdentity(s)
    return { id: current, created: false }
  }
  return { id: createIdentity(), created: true }
}

export function createIdentity(name?: string): Identity {
  const sk = generateSecretKey()
  const pk = getPublicKey(sk)
  secret = sk
  const s: Stored = { method: 'auto', sk: bytesToHex(sk), pk, name: name ?? randomName(), avatar: Math.floor(Math.random() * 360), createdAt: Date.now() }
  save(s)
  current = toIdentity(s)
  return current
}

export function importNsec(input: string): Identity {
  let sk: Uint8Array
  const v = input.trim()
  if (v.startsWith('nsec')) {
    const d = nip19.decode(v)
    if (d.type !== 'nsec') throw new Error('不是有效的 nsec 私钥')
    sk = d.data as Uint8Array
  } else if (/^[0-9a-f]{64}$/i.test(v)) sk = hexToBytes(v)
  else throw new Error('请输入 nsec1... 或 64 位十六进制私钥')
  const pk = getPublicKey(sk)
  secret = sk
  const prev = load()
  const s: Stored = { method: 'nsec', sk: bytesToHex(sk), pk, name: prev?.pk === pk ? prev.name : randomName(), avatar: prev?.avatar ?? Math.floor(Math.random() * 360), createdAt: Date.now() }
  save(s)
  current = toIdentity(s)
  return current
}

export async function loginNip07(): Promise<Identity> {
  if (!window.nostr) throw new Error('未检测到 Nostr 浏览器扩展（如 Alby、nos2x）')
  const pk = await window.nostr.getPublicKey()
  secret = null
  const prev = load()
  const s: Stored = { method: 'nip07', pk, name: prev?.pk === pk ? prev.name : randomName(), avatar: prev?.avatar ?? Math.floor(Math.random() * 360), createdAt: Date.now() }
  save(s)
  current = toIdentity(s)
  return current
}

export function identity(): Identity {
  if (!current) loadIdentity()
  return current!
}

export function setName(name: string) {
  const s = load()
  if (!s) return
  s.name = name.slice(0, 16)
  save(s)
  current = toIdentity(s)
}

export function exportNsec(): string | null {
  const s = load()
  if (!s?.sk) return null
  return nip19.nsecEncode(hexToBytes(s.sk))
}

export function hasNip07() {
  return typeof window !== 'undefined' && !!window.nostr
}

export async function sign(tpl: EventTemplate): Promise<Event> {
  const id = identity()
  if (id.method === 'nip07') {
    if (!window.nostr) throw new Error('Nostr 扩展不可用')
    return window.nostr.signEvent(tpl)
  }
  if (!secret) throw new Error('缺少私钥')
  return finalizeEvent(tpl, secret)
}

/** A NIP-42 style proof that this pubkey joined the given room. */
export async function roomProof(roomId: string): Promise<Event | null> {
  try {
    return await sign({ kind: 22242, created_at: Math.floor(Date.now() / 1000), tags: [['challenge', roomId], ['relay', 'nexusrift']], content: '' })
  } catch { return null }
}

export function verifyRoomProof(ev: any, pk: string, roomId: string): boolean {
  try {
    if (!ev || ev.pubkey !== pk || ev.kind !== 22242) return false
    if (!ev.tags?.some((t: string[]) => t[0] === 'challenge' && t[1] === roomId)) return false
    return verifyEvent(ev)
  } catch { return false }
}

export function shortKey(npub: string) {
  return npub.slice(0, 10) + '…' + npub.slice(-4)
}
