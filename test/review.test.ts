// One directed test per finding of the 2026-09-09 independent review.
import { describe, it, expect } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { NostrEvent } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { matchFilters } from 'nostr-tools/filter'
import {
  DropWatch, Cadence, QuietTransport, EpochExhausted,
  createDrop, createDropSeal, createFiller, openDrop, padToBucket, deriveDropKeyFromIkm, deriveRoomDropKey, pairIkm, pairIkmCases,
  CREATED_AT_JITTER, MAX_PER_EPOCH_PAIR, MAX_PER_EPOCH_ROOM,
} from '../src/index.js'

const NOW = 1_800_000_000
const alice = generateSecretKey(), bob = generateSecretKey()
const pubA = getPublicKey(alice), pubB = getPublicKey(bob)
const roomKey = new Uint8Array(32).fill(7)
const A_ID = getPublicKey(generateSecretKey())
const B_ID = getPublicKey(generateSecretKey())
const tagOf = (e: NostrEvent) => e.tags.find((t) => t[0] === 'p')![1]!
const chat = (text: string, roomId = 'ab'.repeat(32), at = NOW) => finalizeEvent({ kind: 1460, created_at: at, tags: [['d', roomId]], content: text }, generateSecretKey())

/** An in-memory relay that honours since, until and limit (newest first), like a public relay. */
class Relay {
  events: NostrEvent[] = []
  live: { filters: Filter[]; onEvent: (e: NostrEvent, via?: string) => void }[] = []
  failNext = 0
  async publish(event: NostrEvent) {
    if (this.failNext > 0) { this.failNext -= 1; throw new Error('relay closed') }
    this.events.push(event)
    for (const s of this.live) if (matchFilters(s.filters, event)) s.onEvent(event, 'wss://fake.test')
  }
  subscribe(filters: Filter[], onEvent: (e: NostrEvent, via?: string) => void, onEose?: () => void) {
    const sub = { filters, onEvent }
    this.live.push(sub)
    const limit = Math.min(...filters.map((f) => f.limit ?? Infinity))
    const stored = this.events.filter((e) => matchFilters(filters, e)).sort((a, b) => b.created_at - a.created_at).slice(0, limit)
    for (const e of stored) onEvent(e, 'wss://fake.test')
    onEose?.()
    return () => { this.live = this.live.filter((s) => s !== sub) }
  }
  close() {}
}

const quiet = (relay: Relay, member: string, extra: Partial<ConstructorParameters<typeof QuietTransport>[1]> = {}, now = () => NOW) =>
  new QuietTransport(relay, { roomKey, member, members: [A_ID, B_ID], kinds: [1460], intervalSeconds: 60, lookbackSeconds: 7200, slotOffset: () => 0, now, schedule: () => () => {}, ...extra })

describe('P0: no tag is ever used twice', () => {
  it('a burst inside one epoch lands on distinct tags, as fillers do', async () => {
    let now = NOW
    const relay = new Relay()
    const a = quiet(relay, A_ID, {}, () => now)
    for (const t of ['one', 'two', 'three']) await a.publish(chat(t))
    for (let i = 0; i < 5; i++) { await a.tick(); now += 60 }
    const tags = relay.events.map(tagOf)
    expect(relay.events.length).toBe(5)
    expect(new Set(tags).size).toBe(5)
  })
  it('a pair sender never repeats a key in an epoch and stops at the cap', () => {
    const w = new DropWatch(alice, { lookbackEpochs: 1 })
    w.addPeer({ peerPublicKey: pubB })
    const keys = new Set<string>()
    for (let i = 0; i < MAX_PER_EPOCH_PAIR; i++) keys.add(w.sendKey(pubB, NOW).publicKey)
    expect(keys.size).toBe(MAX_PER_EPOCH_PAIR)
    expect(() => w.sendKey(pubB, NOW)).toThrow(EpochExhausted)
    // The next epoch has fresh ones, and the receiver is watching all of them.
    const next = w.sendKey(pubB, NOW + 3600)
    const r = new DropWatch(bob, { lookbackEpochs: 1 })
    r.addPeer({ peerPublicKey: pubA })
    expect(r.match(createDrop({ content: 'x' }, alice, pubB, next.publicKey, { now: () => NOW + 3600 }), NOW + 3600)).not.toBeNull()
    for (const k of keys) expect(r.tags(NOW)).toContain(k)
  })
  it('a room member whose epoch is exhausted posts fillers and the drop waits', async () => {
    let now = NOW
    const relay = new Relay()
    const a = quiet(relay, A_ID, {}, () => now)
    for (let i = 0; i < MAX_PER_EPOCH_ROOM + 1; i++) await a.publish(chat(`m${i}`))
    for (let i = 0; i < MAX_PER_EPOCH_ROOM + 1; i++) { await a.tick(); now += 60 }
    expect(a.pending).toBe(1)
    now = NOW + 3600
    await a.tick()
    expect(a.pending).toBe(0)
    expect(new Set(relay.events.map(tagOf)).size).toBe(relay.events.length)
  })
})

describe('P1: the pair cadence wraps at the slot', () => {
  it('real and filler carry the same expiration and the same created_at distribution', () => {
    const c = new Cadence({ intervalSeconds: 60, ttlSeconds: 86400, slotOffset: () => 0 })
    const key = getPublicKey(generateSecretKey())
    const seal = createDropSeal({ content: 'queued an hour early' }, alice, pubB, { now: () => NOW - 3600 })
    c.enqueue(seal, () => key)
    const real = c.due(NOW)!
    const filler = c.due(NOW + 60)!
    const exp = (e: NostrEvent) => Number(e.tags.find((t) => t[0] === 'expiration')![1])
    // The expiration counts from the jittered created_at on both, so it gives neither the true post time away.
    expect(exp(real) - real.created_at).toBe(86400)
    expect(exp(filler) - filler.created_at).toBe(86400)
    expect(real.created_at).toBeLessThanOrEqual(NOW)
    expect(real.created_at).toBeGreaterThan(NOW - CREATED_AT_JITTER)
    expect(real.content.length).toBe(filler.content.length)
  })
  it('the drop key is asked for when the slot comes, so a wait across an epoch lands on a watched key', () => {
    const w = new DropWatch(alice, { lookbackEpochs: 1 })
    w.addPeer({ peerPublicKey: pubB })
    const r = new DropWatch(bob, { lookbackEpochs: 1 })
    r.addPeer({ peerPublicKey: pubA })
    let asked = 0
    const c = new Cadence({ intervalSeconds: 3600, slotOffset: () => 0 })
    c.enqueue(createDropSeal({ content: 'later' }, alice, pubB, { now: () => NOW }), () => { asked += 1; return w.sendKey(pubB, NOW + 3 * 3600).publicKey })
    expect(asked).toBe(0)
    const wrap = c.due(NOW + 3 * 3600)!
    expect(asked).toBe(1)
    expect(r.match(wrap, NOW + 3 * 3600)).not.toBeNull()
  })
  it('the cadence has a phase and a bound', () => {
    const c = new Cadence({ intervalSeconds: 60 })
    expect(c.nextSlotAt(NOW)).toBeGreaterThanOrEqual(NOW)
    expect(c.nextSlotAt(NOW)).toBeLessThan(NOW + 120)
    const b = new Cadence({ intervalSeconds: 60, slotOffset: () => 0 })
    const seal = createDropSeal({ content: 'x' }, alice, pubB, { now: () => NOW })
    for (let i = 0; i < Cadence.MAX_PENDING; i++) b.enqueue(seal, () => pubB)
    expect(() => b.enqueue(seal, () => pubB)).toThrow(/full/)
  })
})

describe('P1: a rejected publish delays and never discards', () => {
  it('keeps the drop and the slot, reports the error, and posts it on the retry', async () => {
    let now = NOW
    const relay = new Relay()
    const errors: unknown[] = []
    const a = quiet(relay, A_ID, { onError: (e) => errors.push(e) }, () => now)
    await a.publish(chat('fragile'))
    relay.failNext = 1
    await a.tick()
    expect(errors.length).toBe(1)
    expect(a.pending).toBe(1)
    expect(relay.events.length).toBe(0)
    await a.tick()   // same slot, retried
    expect(a.pending).toBe(0)
    expect(relay.events.length).toBe(1)
    now += 60
    await a.tick()
    expect(relay.events.length).toBe(2)
  })
})

describe('P1: one broadcast pull, fanned out', () => {
  it('two quiet subscriptions with different filters each get their own traffic', async () => {
    const relay = new Relay()
    const a = quiet(relay, A_ID)
    const b = quiet(relay, B_ID)
    const ab: NostrEvent[] = [], cd: NostrEvent[] = []
    b.subscribe([{ kinds: [1460], '#d': ['ab'.repeat(32)] }], (e) => ab.push(e))
    b.subscribe([{ kinds: [1460], '#d': ['cd'.repeat(32)] }], (e) => cd.push(e))
    await a.publish(chat('for cd', 'cd'.repeat(32)))
    await a.tick()
    expect(cd.map((e) => e.content)).toEqual(['for cd'])
    expect(ab.length).toBe(0)
    expect(relay.live.filter((s) => s.filters[0]!.kinds?.includes(1059)).length).toBe(1)   // one live broadcast for b, however many subscriptions
  })
})

describe('P1: the receiver keeps the lookback, not three epochs', () => {
  it('matches a wrap from five epochs ago, and not one beyond the lookback', () => {
    const s = new DropWatch(alice, { lookbackEpochs: 1 })
    s.addPeer({ peerPublicKey: pubB })
    const r = new DropWatch(bob, { lookbackEpochs: 6 })
    r.addPeer({ peerPublicKey: pubA })
    const old = createDrop({ content: 'asleep' }, alice, pubB, s.sendKey(pubB, NOW - 5 * 3600).publicKey, { now: () => NOW - 5 * 3600 })
    expect(r.match(old, NOW)).not.toBeNull()
    const tooOld = createDrop({ content: 'gone' }, alice, pubB, s.sendKey(pubB, NOW - 8 * 3600).publicKey, { now: () => NOW - 8 * 3600 })
    expect(r.match(tooOld, NOW)).toBeNull()
    // The table moves with the clock: an epoch that was inside the lookback falls out.
    expect(r.match(old, NOW + 3 * 3600)).toBeNull()
  })
})

describe('P1: the backfill is paged', () => {
  it('a relay that caps pages at 100 still yields a message buried under 350 fillers', async () => {
    const relay = new Relay()
    const a = quiet(relay, A_ID)
    await a.publish(chat('buried'))
    await a.tick()
    for (let i = 0; i < 350; i++) relay.events.push(createFiller({ now: () => NOW }))
    const got: NostrEvent[] = []
    let eose = 0
    const b = quiet(relay, B_ID, { pageSize: 100 })
    b.subscribe([{ kinds: [1460] }], (e) => got.push(e), () => { eose += 1 })
    await new Promise((r) => setTimeout(r, 0))   // pages chain on fresh stacks
    expect(got.map((e) => e.content)).toEqual(['buried'])
    expect(eose).toBe(1)
  })
})

describe('P2: dedup after opening, keyed on the inner id', () => {
  it('junk on a real tag with a real id does not burn the real wrap', () => {
    const s = new DropWatch(alice, { lookbackEpochs: 1 })
    s.addPeer({ peerPublicKey: pubB })
    const r = new DropWatch(bob, { lookbackEpochs: 1 })
    r.addPeer({ peerPublicKey: pubA })
    const real = createDrop({ content: 'real' }, alice, pubB, s.sendKey(pubB, NOW).publicKey, { now: () => NOW })
    const junk = { ...real, content: 'AAAA' }
    const m1 = r.match(junk, NOW)!
    expect(() => openDrop(junk, m1.key.privateKey, bob)).toThrow()
    const m2 = r.match(real, NOW)!
    const opened = openDrop(real, m2.key.privateKey, bob)
    expect(opened.rumor.content).toBe('real')
    expect(r.remember(opened.rumor.id)).toBe(true)
    expect(r.remember(opened.rumor.id)).toBe(false)
  })
  it('a room transport shows a re-wrapped inner event once', async () => {
    const relay = new Relay()
    const a = quiet(relay, A_ID)
    const b = quiet(relay, B_ID)
    const got: NostrEvent[] = []
    b.subscribe([{ kinds: [1460] }], (e) => got.push(e))
    const msg = chat('once')
    await a.publish(msg)
    await a.tick()
    // Someone who holds the room key re-wraps the same inner event to a fresh key.
    const rewrap = (await import('../src/index.js')).createRoomDrop(msg, deriveRoomDropKey(roomKey, Math.floor(NOW / 3600), A_ID, 5).publicKey, { now: () => NOW })
    await relay.publish(rewrap)
    expect(got.length).toBe(1)
  })
})

describe('P2: card transitions', () => {
  it('a receiver watches every case the pair could be in, and says which matched', () => {
    const EA = generateSecretKey(), EB = generateSecretKey()
    // Alice has both cards; Bob has his own ephemeral but not Alice's card yet.
    const aliceMaterial = { myPrivateKey: alice, peerPublicKey: pubB, myEphemeralPrivateKey: EA, peerEphemeralPublicKey: getPublicKey(EB) }
    const bobMaterial = { myPrivateKey: bob, peerPublicKey: pubA, myEphemeralPrivateKey: EB }
    expect(pairIkm(aliceMaterial).case).toBe('both')
    expect(pairIkm(bobMaterial).case).toBe('one')
    expect(pairIkmCases(aliceMaterial).length).toBe(4)
    const bobKey = deriveDropKeyFromIkm(pairIkm(bobMaterial).ikm, 'one', Math.floor(NOW / 3600), pubB, 3)
    const wrap = createDrop({ content: 'out of step' }, bob, pubA, bobKey.publicKey, { now: () => NOW })
    const r = new DropWatch(alice, { lookbackEpochs: 1 })
    r.addPeer({ peerPublicKey: pubB, myEphemeralPrivateKey: EA, peerEphemeralPublicKey: getPublicKey(EB) })
    const m = r.match(wrap, NOW)
    expect(m).not.toBeNull()
    expect(m!.alternate).toBe(true)
    expect(openDrop(wrap, m!.key.privateKey, alice).rumor.content).toBe('out of step')
  })
})

describe('P2: shapes and ranges', () => {
  it('padToBucket needs created_at, the derivation rejects bad epochs and counters, room keys say room', () => {
    expect(() => padToBucket({ kind: 14, content: 'x', tags: [] }, 512)).toThrow(/created_at/)
    const ikm = pairIkm({ myPrivateKey: alice, peerPublicKey: pubB }).ikm
    expect(() => deriveDropKeyFromIkm(ikm, 'none', -1, pubA)).toThrow(/epoch/)
    expect(() => deriveDropKeyFromIkm(ikm, 'none', NaN, pubA)).toThrow(/epoch/)
    expect(() => deriveDropKeyFromIkm(ikm, 'none', 1, pubA, 65536)).toThrow(/counter/)
    expect(() => deriveDropKeyFromIkm(ikm, 'none', 1, pubA.toUpperCase())).toThrow(/sender/)
    expect(deriveRoomDropKey(roomKey, 1, A_ID).case).toBe('room')
    expect(deriveDropKeyFromIkm(ikm, 'none', 1, pubA, 0).publicKey).not.toBe(deriveDropKeyFromIkm(ikm, 'none', 1, pubA, 1).publicKey)
  })
})
