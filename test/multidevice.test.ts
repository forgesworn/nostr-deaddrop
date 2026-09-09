// Two devices on one member, and the hook a client persists counters on.
import { describe, it, expect } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { NostrEvent } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { matchFilters } from 'nostr-tools/filter'
import { QuietTransport, EpochExhausted, KeyTable, roomIkm, MAX_PER_EPOCH_ROOM } from '../src/index.js'

const NOW = 1_800_000_000
const roomKey = new Uint8Array(32).fill(9)
const A_ID = getPublicKey(generateSecretKey())
const B_ID = getPublicKey(generateSecretKey())
const chat = (text: string) => finalizeEvent({ kind: 1460, created_at: NOW, tags: [['d', 'ab'.repeat(32)]], content: text }, generateSecretKey())

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
    for (const e of this.events.filter((e) => matchFilters(filters, e)).sort((a, b) => b.created_at - a.created_at).slice(0, limit)) onEvent(e, 'wss://fake.test')
    onEose?.()
    return () => { this.live = this.live.filter((s) => s !== sub) }
  }
  close() {}
}

const quiet = (relay: Relay, member: string, extra: Partial<ConstructorParameters<typeof QuietTransport>[1]> = {}, now = () => NOW) =>
  new QuietTransport(relay, { roomKey, member, members: [A_ID, B_ID], kinds: [1460], intervalSeconds: 60, lookbackSeconds: 7200, slotOffset: () => 0, now, schedule: () => () => {}, ...extra })

describe('two devices on one member', () => {
  it('a counter seen on the wire is spent for the device that saw it', async () => {
    const relay = new Relay()
    let now = NOW
    const clock = () => now
    const laptop = quiet(relay, A_ID, {}, clock)
    const phone = quiet(relay, A_ID, {}, clock)
    phone.subscribe([{ kinds: [1460] }], () => {})
    // The laptop posts one real drop; the phone sees the wrap by broadcast.
    await laptop.publish(chat('from the laptop'))
    await laptop.tick()
    const used = laptop.exportUsed()[A_ID]!.counters
    expect(used.length).toBe(1)
    expect(phone.exportUsed()[A_ID]?.counters).toEqual(used)
    // The phone can now draw every counter but that one.
    let drawn = 0
    for (;;) {
      try { phone.sendKey(); drawn += 1 } catch (e) { expect(e).toBeInstanceOf(EpochExhausted); break }
    }
    expect(drawn).toBe(MAX_PER_EPOCH_ROOM - 1)
  })
  it('a wrap on another member\'s key, or one that does not open, marks nothing', async () => {
    const relay = new Relay()
    const a = quiet(relay, A_ID)
    const b = quiet(relay, B_ID)
    a.subscribe([{ kinds: [1460] }], () => {})
    await b.publish(chat('from b'))
    await b.tick()
    expect(a.exportUsed()[A_ID]).toBeUndefined()
    // A stranger posts junk to one of A's real tags: nothing is marked.
    const key = a.sendKey()
    const junk = finalizeEvent({ kind: 1059, created_at: NOW, tags: [['p', key.publicKey]], content: 'zzz' }, generateSecretKey())
    const c = quiet(relay, A_ID)
    c.subscribe([{ kinds: [1460] }], () => {})
    await relay.publish(junk)
    expect(c.exportUsed()[A_ID]).toBeUndefined()
  })
  it('markUsed ignores another epoch and another ikm', () => {
    const t = new KeyTable<string>(3600, 2)
    const ikm = roomIkm(roomKey)
    t.set(A_ID, { ikm, case: 'room', sender: A_ID, max: MAX_PER_EPOCH_ROOM }, A_ID)
    const e = Math.floor(NOW / 3600)
    t.markUsed(A_ID, ikm, e - 1, 3, NOW)
    t.markUsed(A_ID, ikm, e + 1, 4, NOW)
    t.markUsed(A_ID, roomIkm(new Uint8Array(32).fill(1)), e, 5, NOW)
    expect(t.exportUsed()[A_ID]).toBeUndefined()
    t.markUsed(A_ID, ikm, e, 6, NOW)
    expect(t.exportUsed()[A_ID]).toEqual({ epoch: e, counters: [6] })
  })
})

describe('onPosted', () => {
  it('fires once the relay took the wrap, with the inner for a drop and none for a filler', async () => {
    const relay = new Relay()
    const posted: { slot: number; inner?: NostrEvent; wrap: NostrEvent }[] = []
    let now = NOW
    const a = quiet(relay, A_ID, { onPosted: (p) => posted.push(p) }, () => now)
    const m = chat('hello')
    await a.publish(m)
    relay.failNext = 1
    await a.tick()
    expect(posted.length).toBe(0)
    await a.tick()
    expect(posted.length).toBe(1)
    expect(posted[0]!.inner?.id).toBe(m.id)
    expect(posted[0]!.wrap.id).toBe(relay.events[0]!.id)
    now += 60
    await a.tick()
    expect(posted.length).toBe(2)
    expect(posted[1]!.inner).toBeUndefined()
  })
  it('a throwing onPosted reports through onError and the slot still counts as served', async () => {
    const relay = new Relay()
    const errors: unknown[] = []
    const a = quiet(relay, A_ID, { onPosted: () => { throw new Error('storage full') }, onError: (e) => errors.push(e) })
    await a.publish(chat('x'))
    await a.tick()
    expect(errors.length).toBe(1)
    expect(a.pending).toBe(0)
    await a.tick()
    expect(relay.events.length).toBe(1)
  })
})

describe('drop', () => {
  it('takes a queued event back, including one whose wrap was built and refused', async () => {
    const relay = new Relay()
    const a = quiet(relay, A_ID, { onError: () => {} })
    const m1 = chat('one'), m2 = chat('two')
    await a.publish(m1)
    await a.publish(m2)
    expect(a.drop(m2.id)).toBe(true)
    expect(a.drop(m2.id)).toBe(false)
    expect(a.pending).toBe(1)
    relay.failNext = 1
    await a.tick()               // m1's wrap is built and kept for a retry
    expect(a.drop(m1.id)).toBe(true)
    await a.tick()               // the slot is served by a filler, not by m1
    expect(relay.events.length).toBe(1)
    const posted = relay.events[0]!
    const c = quiet(relay, B_ID)
    const seen: NostrEvent[] = []
    c.subscribe([{ kinds: [1460] }], (e) => seen.push(e))
    expect(seen.length).toBe(0)
    expect(posted.kind).toBe(1059)
  })
})
