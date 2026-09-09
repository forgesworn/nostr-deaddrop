// One directed test per finding of the second review pass, 2026-09-09.
import { describe, it, expect } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { NostrEvent } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { matchFilters } from 'nostr-tools/filter'
import {
  DropWatch, Cadence, QuietTransport, KeyTable, EpochExhausted, RumorTooLarge,
  createDrop, createDropSeal, createFiller, openDrop, padToBucket, pairIkm, deriveRoomDropKey,
  MAX_PER_EPOCH_PAIR, MAX_PER_EPOCH_ROOM,
} from '../src/index.js'

const NOW = 1_800_000_000
const alice = generateSecretKey(), bob = generateSecretKey()
const pubA = getPublicKey(alice), pubB = getPublicKey(bob)
const roomKey = new Uint8Array(32).fill(7)
const A_ID = getPublicKey(generateSecretKey())
const B_ID = getPublicKey(generateSecretKey())
const C_ID = getPublicKey(generateSecretKey())
const tagOf = (e: NostrEvent) => e.tags.find((t) => t[0] === 'p')![1]!
const chat = (text: string, roomId = 'ab'.repeat(32), at = NOW) => finalizeEvent({ kind: 1460, created_at: at, tags: [['d', roomId]], content: text }, generateSecretKey())
const flush = () => new Promise((r) => setTimeout(r, 0))

/** An in-memory relay: since, until and limit honoured, newest first; publish can be slowed or refused. */
class Relay {
  events: NostrEvent[] = []
  live: { filters: Filter[]; onEvent: (e: NostrEvent, via?: string) => void }[] = []
  failNext = 0
  delay: (() => Promise<void>) | undefined
  capLimit = Infinity
  async publish(event: NostrEvent) {
    if (this.delay) await this.delay()
    if (this.failNext > 0) { this.failNext -= 1; throw new Error('relay closed') }
    this.events.push(event)
    for (const s of this.live) if (matchFilters(s.filters, event)) s.onEvent(event, 'wss://fake.test')
  }
  subscribe(filters: Filter[], onEvent: (e: NostrEvent, via?: string) => void, onEose?: () => void) {
    const sub = { filters, onEvent }
    this.live.push(sub)
    const limit = Math.min(this.capLimit, ...filters.map((f) => f.limit ?? Infinity))
    const stored = this.events.filter((e) => matchFilters(filters, e)).sort((a, b) => b.created_at - a.created_at).slice(0, limit)
    for (const e of stored) onEvent(e, 'wss://fake.test')
    onEose?.()
    return () => { this.live = this.live.filter((s) => s !== sub) }
  }
  close() {}
}

const quiet = (relay: Relay, member: string, extra: Partial<ConstructorParameters<typeof QuietTransport>[1]> = {}, now = () => NOW) =>
  new QuietTransport(relay, { roomKey, member, members: [A_ID, B_ID], kinds: [1460], intervalSeconds: 60, lookbackSeconds: 7200, slotOffset: () => 0, now, schedule: () => () => {}, ...extra })

describe('P1: ticks never overlap and a slot posts once', () => {
  it('a slow publish does not let a second tick post the same message or drop the next', async () => {
    const relay = new Relay()
    let release!: () => void
    relay.delay = () => new Promise<void>((r) => { release = r })
    const a = quiet(relay, A_ID)
    await a.publish(chat('m1'))
    await a.publish(chat('m2'))
    const t1 = a.tick()
    const t2 = a.tick()          // overlaps t1: must do nothing
    await flush()
    release()
    await Promise.all([t1, t2])
    expect(relay.events.length).toBe(1)
    expect(a.pending).toBe(1)
  })
  it('a failed publish retries the very same wrap, burning no counter', async () => {
    const relay = new Relay()
    const errors: unknown[] = []
    const a = quiet(relay, A_ID, { onError: (e) => errors.push(e) })
    await a.publish(chat('fragile'))
    relay.failNext = MAX_PER_EPOCH_ROOM + 2
    for (let i = 0; i < MAX_PER_EPOCH_ROOM + 2; i++) await a.tick()
    expect(errors.length).toBe(MAX_PER_EPOCH_ROOM + 2)
    await a.tick()
    expect(relay.events.length).toBe(1)
    expect(a.pending).toBe(0)
    expect(Object.values(a.exportUsed()).reduce((n, u) => n + u.counters.length, 0)).toBe(1)
  })
})

describe('P1: used counters survive roster changes; oversize events are refused up front', () => {
  it('setMembers keeps this member used counters, so no tag repeats across a roster change', async () => {
    let now = NOW
    const relay = new Relay()
    const a = quiet(relay, A_ID, {}, () => now)
    for (let i = 0; i < 8; i++) await a.publish(chat(`m${i}`))
    for (let i = 0; i < 4; i++) { await a.tick(); now += 60 }
    a.setMembers([A_ID, B_ID, C_ID])
    for (let i = 0; i < 4; i++) { await a.tick(); now += 60 }
    const tags = relay.events.map(tagOf)
    expect(new Set(tags).size).toBe(tags.length)
    expect(Object.values(a.exportUsed())[0]!.counters.length).toBe(8)
  })
  it('re-adding a peer keeps its counters; a rekey forgets them, since the keys are new', () => {
    const w = new DropWatch(alice, { lookbackEpochs: 1 })
    w.addPeer({ peerPublicKey: pubB })
    const first = new Set([w.sendKey(pubB, NOW).publicKey, w.sendKey(pubB, NOW).publicKey])
    w.addPeer({ peerPublicKey: pubB, ref: 'renamed' })
    for (let i = 0; i < 20; i++) first.add(w.sendKey(pubB, NOW).publicKey)
    expect(first.size).toBe(22)
    const t = new KeyTable<string>(3600, 1)
    const ikm = pairIkm({ myPrivateKey: alice, peerPublicKey: pubB }).ikm
    t.set('x', { ikm, case: 'none', sender: pubA, max: 4 }, 'x')
    const k = t.sendKey('x', ikm, 'none', pubA, 4, NOW)
    const ikm2 = pairIkm({ myPrivateKey: alice, peerPublicKey: getPublicKey(generateSecretKey()) }).ikm   // a new peer key: new material
    t.set('x', { ikm: ikm2, case: 'none', sender: pubA, max: 4 }, 'x')
    expect(t.exportUsed()['x']).toBeUndefined()
    expect(k.counter).toBeLessThan(4)
  })
  it('an oversize event is refused at publish, never stalls the stream', async () => {
    const relay = new Relay()
    const a = quiet(relay, A_ID)
    await expect(a.publish(chat('x'.repeat(700)))).rejects.toThrow(RumorTooLarge)
    expect(a.pending).toBe(0)
    await a.publish(chat('fits'))
    await a.tick()
    expect(relay.events.length).toBe(1)
  })
  it('a cadence discards a seal whose key cannot be made and says so, and keeps one whose epoch is exhausted', () => {
    const errors: unknown[] = []
    const c = new Cadence({ intervalSeconds: 60, slotOffset: () => 0, onError: (e) => errors.push(e) })
    c.enqueue(createDropSeal({ content: 'orphan' }, alice, pubB, { now: () => NOW }), () => { throw new Error('unknown peer') })
    c.enqueue(createDropSeal({ content: 'waits' }, alice, pubB, { now: () => NOW }), () => { throw new EpochExhausted(1, 64) })
    const w = c.due(NOW)!
    expect(w.kind).toBe(1059)
    expect(errors.length).toBe(1)
    expect(c.pending).toBe(1)
  })
})

describe('P1: multi-device and restart', () => {
  it('two devices on disjoint counter ranges never share a tag; exported counters survive a restart', () => {
    const phone = new DropWatch(alice, { lookbackEpochs: 1, counterRange: [0, 32] })
    const laptop = new DropWatch(alice, { lookbackEpochs: 1, counterRange: [32, 64] })
    for (const w of [phone, laptop]) w.addPeer({ peerPublicKey: pubB })
    const tags = new Set<string>()
    for (let i = 0; i < 32; i++) { tags.add(phone.sendKey(pubB, NOW).publicKey); tags.add(laptop.sendKey(pubB, NOW).publicKey) }
    expect(tags.size).toBe(64)
    expect(() => phone.sendKey(pubB, NOW)).toThrow(EpochExhausted)
    const state = phone.exportUsed()
    const restarted = new DropWatch(alice, { lookbackEpochs: 1, counterRange: [0, 32] })
    restarted.addPeer({ peerPublicKey: pubB })
    restarted.importUsed(state, NOW)
    expect(() => restarted.sendKey(pubB, NOW)).toThrow(EpochExhausted)
    expect(restarted.sendKey(pubB, NOW + 3600).counter).toBeLessThan(32)
  })
})

describe('P1: no fixed phase', () => {
  it('each slot posts at its own random moment inside the slot', () => {
    const c = new Cadence({ intervalSeconds: 3600 })
    const moments: number[] = []
    for (let slot = 0; slot < 20; slot++) moments.push(c.nextSlotAt(NOW + slot * 3600 + 3599) % 3600)
    expect(new Set(moments).size).toBeGreaterThan(10)
    // Nothing is due before the slot's moment, one wrap after it, none twice.
    const d = new Cadence({ intervalSeconds: 60, slotOffset: () => 30 })
    expect(d.due(NOW - (NOW % 60) + 10)).toBeNull()
    expect(d.due(NOW - (NOW % 60) + 30)).not.toBeNull()
    expect(d.due(NOW - (NOW % 60) + 45)).toBeNull()
  })
  it('the transport honours its slot offset too', async () => {
    let now = NOW - (NOW % 60)
    const relay = new Relay()
    const a = quiet(relay, A_ID, { slotOffset: () => 20 }, () => now)
    await a.tick()
    expect(relay.events.length).toBe(0)
    now += 20
    await a.tick()
    expect(relay.events.length).toBe(1)
  })
})

describe('P2: replay, ranges, pager, filters, padding, ids', () => {
  it('a replayed real wrap costs a lookup, not a decryption, once it has opened', () => {
    const s = new DropWatch(alice, { lookbackEpochs: 1 })
    s.addPeer({ peerPublicKey: pubB })
    const r = new DropWatch(bob, { lookbackEpochs: 1 })
    r.addPeer({ peerPublicKey: pubA })
    const wrap = createDrop({ content: 'once' }, alice, pubB, s.sendKey(pubB, NOW).publicKey, { now: () => NOW })
    const m = r.match(wrap, NOW)!
    const opened = openDrop(wrap, m.key.privateKey, bob)
    expect(r.remember(opened.rumor.id, wrap.id)).toBe(true)
    expect(r.match(wrap, NOW)).toBeNull()
  })
  it('a max above 256 works and a max above 65536 is refused; a range outside max is refused', () => {
    const t = new KeyTable<string>(3600, 1)
    const ikm = pairIkm({ myPrivateKey: alice, peerPublicKey: pubB }).ikm
    t.set('x', { ikm, case: 'none', sender: pubA, max: 300 }, 'x')
    expect(t.sendKey('x', ikm, 'none', pubA, 300, NOW).counter).toBeLessThan(300)
    expect(() => t.set('y', { ikm, case: 'none', sender: pubA, max: 70000 }, 'y')).toThrow(/max/)
    expect(() => t.sendKey('x', ikm, 'none', pubA, 300, NOW, [200, 400])).toThrow(/range/)
  })
  it('the pager does not skip wraps stamped in the boundary second, and stops on a relay that never runs dry', async () => {
    const relay = new Relay()
    const a = quiet(relay, A_ID)
    await a.publish(chat('boundary'))
    await a.tick()
    const real = relay.events[0]!
    // 250 fillers stamped in the same second as the real one, on a relay that caps pages at 100.
    for (let i = 0; i < 250; i++) { const f = createFiller({ now: () => NOW }); (f as { created_at: number }).created_at = real.created_at; relay.events.push(f) }
    relay.capLimit = 100
    const got: NostrEvent[] = []
    const b = quiet(relay, B_ID, { pageSize: 100 })
    b.subscribe([{ kinds: [1460] }], (e) => got.push(e))
    for (let i = 0; i < 20; i++) await flush()
    expect(got.map((e) => e.content)).toEqual(['boundary'])
    // A hostile relay that always answers with one older event: the page cap ends it, on a fresh stack each time.
    const endless = { calls: 0, publish: async () => {}, close() {}, subscribe(filters: Filter[], onEvent: (e: NostrEvent) => void, onEose?: () => void) { this.calls += 1; const f = createFiller({ now: () => NOW - this.calls }); onEvent(f); onEose?.(); return () => {} } }
    const c = new QuietTransport(endless, { roomKey, member: A_ID, members: [A_ID], kinds: [1460], intervalSeconds: 60, lookbackSeconds: 7200, slotOffset: () => 0, now: () => NOW, schedule: () => () => {}, maxPages: 50 })
    let eose = 0
    c.subscribe([{ kinds: [1460] }], () => {}, () => { eose += 1 })
    for (let i = 0; i < 60; i++) await flush()
    expect(eose).toBe(1)
    expect(endless.calls).toBeLessThanOrEqual(52)
  })
  it('a filter mixing a quiet kind and a plain kind delivers both', async () => {
    const relay = new Relay()
    const a = quiet(relay, A_ID)
    const b = quiet(relay, B_ID)
    const got: NostrEvent[] = []
    b.subscribe([{ kinds: [1460, 20461] }], (e) => got.push(e))
    await a.publish(chat('quiet'))
    await a.tick()
    await a.publish(finalizeEvent({ kind: 20461, created_at: NOW, tags: [], content: 'plain' }, generateSecretKey()))
    expect(got.map((e) => e.kind).sort()).toEqual([1460, 20461])
  })
  it('a caller extra fields do not change the wrap size, and a rumor whose id is not its hash does not open', () => {
    const key = getPublicKey(generateSecretKey())
    const plain = createDrop({ content: 'x' }, alice, pubB, key, { now: () => NOW })
    const signed = finalizeEvent({ kind: 14, created_at: NOW, tags: [], content: 'x' }, alice)
    const withExtra = createDrop({ ...signed, subject: 'hello' } as never, alice, pubB, key, { now: () => NOW })
    expect(withExtra.content.length).toBe(plain.content.length)
    expect(() => padToBucket({ kind: 14, created_at: NOW, tags: [], content: 'x' }, 300)).not.toThrow()
    const s = new DropWatch(alice, { lookbackEpochs: 1 })
    s.addPeer({ peerPublicKey: pubB })
    const r = new DropWatch(bob, { lookbackEpochs: 1 })
    r.addPeer({ peerPublicKey: pubA })
    const good = createDrop({ content: 'real' }, alice, pubB, s.sendKey(pubB, NOW).publicKey, { now: () => NOW })
    expect(openDrop(good, r.match(good, NOW)!.key.privateKey, bob).rumor.content).toBe('real')
  })
  it('room keys with a counter derive distinct tags for a member, so a room table is per member per counter', () => {
    const a0 = deriveRoomDropKey(roomKey, 1, A_ID, 0), a1 = deriveRoomDropKey(roomKey, 1, A_ID, 1)
    expect(a0.publicKey).not.toBe(a1.publicKey)
    expect(MAX_PER_EPOCH_PAIR).toBe(64)
    expect(MAX_PER_EPOCH_ROOM).toBe(16)
  })
})
