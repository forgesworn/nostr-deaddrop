import { describe, it, expect } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { NostrEvent } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { matchFilters } from 'nostr-tools/filter'
import { deriveRoomDropKey, deriveRoomDropWindow, createRoomDrop, openRoomDrop, createRoomFiller, deriveDropKey, QuietTransport } from '../src/index.js'

const roomKey = new Uint8Array(32).fill(7)
const NOW = 1_800_000_000
const EPOCH = Math.floor(NOW / 3600)
const A_ID = getPublicKey(generateSecretKey())
const B_ID = getPublicKey(generateSecretKey())
const MEMBERS = [A_ID, B_ID]

function chat(text: string, roomId = 'ab'.repeat(32)): NostrEvent {
  return finalizeEvent({ kind: 1460, created_at: NOW, tags: [['d', roomId]], content: text }, generateSecretKey())
}

describe('room drops', () => {
  it('everyone with the room key derives every member\'s drop key, one per member per epoch', () => {
    const a = deriveRoomDropKey(roomKey, EPOCH, A_ID)
    const b = deriveRoomDropKey(new Uint8Array(roomKey), EPOCH, A_ID)
    expect(a.publicKey).toBe(b.publicKey)
    expect(getPublicKey(a.privateKey)).toBe(a.publicKey)
    expect(deriveRoomDropKey(roomKey, EPOCH + 1, A_ID).publicKey).not.toBe(a.publicKey)
    expect(deriveRoomDropKey(roomKey, EPOCH, B_ID).publicKey).not.toBe(a.publicKey)
    const pair = deriveDropKey({ myPrivateKey: roomKey, peerPublicKey: getPublicKey(generateSecretKey()) }, EPOCH, A_ID)
    expect(pair.publicKey).not.toBe(a.publicKey)
    expect(deriveRoomDropWindow(roomKey, NOW, A_ID).map((k) => k.epochIndex)).toEqual([EPOCH - 1, EPOCH, EPOCH + 1])
  })
  it('wraps a signed room event and opens it verified, with nothing of the room on the wire', () => {
    const inner = chat('hello room')
    const key = deriveRoomDropKey(roomKey, EPOCH, A_ID)
    const drop = createRoomDrop(inner, key.publicKey, { now: () => NOW })
    const wire = JSON.stringify(drop)
    expect(wire.includes(inner.pubkey)).toBe(false)
    expect(wire.includes('ab'.repeat(32))).toBe(false)
    expect(wire.includes('1460')).toBe(false)
    expect(openRoomDrop(drop, key.privateKey)).toEqual(inner)
    expect(() => openRoomDrop(drop, generateSecretKey())).toThrow()
  })
  it('real and filler room drops are the same size', () => {
    const key = deriveRoomDropKey(roomKey, EPOCH, A_ID)
    const sizes = new Set<number>()
    for (const t of ['', 'x', 'a longer message than the others by some way']) sizes.add(createRoomDrop(chat(t), key.publicKey, { now: () => NOW }).content.length)
    for (let i = 0; i < 3; i++) sizes.add(createRoomFiller(1460, { now: () => NOW }).content.length)
    expect(sizes.size).toBe(1)
  })
})

/** An in-memory relay: publish delivers to every matching subscriber and stores for later. */
class FakeTransport {
  events: NostrEvent[] = []
  subs: { filters: Filter[]; onEvent: (e: NostrEvent, via?: string) => void }[] = []
  async publish(event: NostrEvent) {
    this.events.push(event)
    for (const s of this.subs) if (matchFilters(s.filters, event)) s.onEvent(event, 'wss://fake.test')
  }
  subscribe(filters: Filter[], onEvent: (e: NostrEvent, via?: string) => void, onEose?: () => void) {
    const sub = { filters, onEvent }
    this.subs.push(sub)
    for (const e of this.events) if (matchFilters(filters, e)) onEvent(e, 'wss://fake.test')
    onEose?.()
    return () => { this.subs = this.subs.filter((s) => s !== sub) }
  }
  close() {}
  describe() { return [{ url: 'wss://fake.test', read: true, write: true }] }
}

describe('QuietTransport', () => {
  it('carries chat inside drops on the cadence, delivers it back through the original filter, and fills empty slots', async () => {
    let now = NOW
    const relay = new FakeTransport()
    const ticks: (() => void)[] = []
    const mk = (member: string) => new QuietTransport(relay, { roomKey, member, members: MEMBERS, kinds: [1460], intervalSeconds: 60, now: () => now, phaseSeconds: 0, schedule: (tick) => { ticks.push(tick); return () => {} } })
    const alice = mk(A_ID)
    const bob = mk(B_ID)
    const got: NostrEvent[] = []
    bob.subscribe([{ kinds: [1460], '#d': ['ab'.repeat(32)], since: NOW - 100 }], (e) => got.push(e))

    const msg = chat('quietly')
    await alice.publish(msg)
    expect(relay.events.length).toBe(0)           // nothing leaves before the slot
    expect(alice.pending).toBe(1)
    await alice.tick()
    expect(relay.events.length).toBe(1)
    expect(relay.events[0]!.kind).toBe(1059)
    expect(JSON.stringify(relay.events[0]).includes('ab'.repeat(32))).toBe(false)
    expect(got.map((e) => e.id)).toEqual([msg.id])

    // Another room's chat is not delivered, and a filler is posted for an empty slot.
    await alice.publish(chat('elsewhere', 'cd'.repeat(32)))
    now += 60
    await alice.tick()
    expect(got.length).toBe(1)
    now += 60
    await alice.tick()
    expect(relay.events.length).toBe(3)
    expect(relay.events[2]!.content.length).toBe(relay.events[0]!.content.length)
    expect(got.length).toBe(1)

    // A kind outside the quiet set passes straight through.
    const plain = finalizeEvent({ kind: 20461, created_at: NOW, tags: [['d', 'ab'.repeat(32)]], content: 'presence' }, generateSecretKey())
    const plainGot: NostrEvent[] = []
    bob.subscribe([{ kinds: [20461], '#d': ['ab'.repeat(32)] }], (e) => plainGot.push(e))
    await alice.publish(plain)
    expect(relay.events.at(-1)!.kind).toBe(20461)
    expect(plainGot.map((e) => e.id)).toEqual([plain.id])
    expect(bob.describe()[0]!.url).toBe('wss://fake.test')
    alice.close(); bob.close()
  })
  it('after a rekey, old drops open for old members and new drops do not', async () => {
    let now = NOW
    const relay = new FakeTransport()
    const key2 = new Uint8Array(32).fill(8)
    const mk = (k: Uint8Array, member: string) => new QuietTransport(relay, { roomKey: k, member, members: MEMBERS, kinds: [1460], intervalSeconds: 60, now: () => now, phaseSeconds: 0, schedule: () => () => {} })
    const alice = mk(roomKey, A_ID)
    const removed = mk(roomKey, B_ID)
    const got: NostrEvent[] = []
    removed.subscribe([{ kinds: [1460] }], (e) => got.push(e))
    await alice.publish(chat('before'))
    await alice.tick()
    expect(got.length).toBe(1)
    alice.rekey(key2)
    now += 60
    await alice.publish(chat('after'))
    await alice.tick()
    expect(relay.events.length).toBe(2)
    expect(got.length).toBe(1)
    const stillIn = mk(key2, B_ID)
    const got2: NostrEvent[] = []
    stillIn.subscribe([{ kinds: [1460] }], (e) => got2.push(e))
    expect(got2.map((e) => e.content)).toEqual(['after'])
  })
  it('a burst is wrapped when its slot comes, one per slot, on the key current then', async () => {
    let now = NOW
    const relay = new FakeTransport()
    const alice = new QuietTransport(relay, { roomKey, member: A_ID, members: MEMBERS, kinds: [1460], intervalSeconds: 60, epochSeconds: 60, now: () => now, phaseSeconds: 0, schedule: () => () => {} })
    await alice.publish(chat('one'))
    await alice.publish(chat('two'))
    expect(alice.pending).toBe(2)
    await alice.tick()
    now += 60
    await alice.tick()
    expect(relay.events.length).toBe(2)
    const tags = relay.events.map((e) => e.tags.find((t) => t[0] === 'p')![1])
    expect(tags[0]).not.toBe(tags[1])   // a new epoch, a new key, so the burst does not stack on one tag
    expect(alice.pending).toBe(0)
  })
  it('a transport with the wrong room key sees nothing', async () => {
    const relay = new FakeTransport()
    const alice = new QuietTransport(relay, { roomKey, member: A_ID, members: MEMBERS, kinds: [1460], intervalSeconds: 60, now: () => NOW, phaseSeconds: 0, schedule: () => () => {} })
    const other = new QuietTransport(relay, { roomKey: new Uint8Array(32).fill(9), member: B_ID, members: MEMBERS, kinds: [1460], intervalSeconds: 60, now: () => NOW, phaseSeconds: 0, schedule: () => () => {} })
    const got: NostrEvent[] = []
    other.subscribe([{ kinds: [1460] }], (e) => got.push(e))
    await alice.publish(chat('secret'))
    await alice.tick()
    expect(relay.events.length).toBe(1)
    expect(got.length).toBe(0)
  })
})
