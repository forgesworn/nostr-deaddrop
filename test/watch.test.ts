import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { DropWatch, createDrop, createDropSeal, createFiller, openDrop, broadcastFilter, taggedFilter, Cadence, CREATED_AT_JITTER, MAX_PER_EPOCH_PAIR } from '../src/index.js'

const alice = generateSecretKey()
const bob = generateSecretKey()
const carol = generateSecretKey()
const NOW = 1_800_000_000
const SMALL = { lookbackEpochs: 2 }

describe('DropWatch', () => {
  it('matches a drop from a known peer and ignores everything else', () => {
    const bobWatch = new DropWatch(bob, SMALL)
    bobWatch.addPeer({ peerPublicKey: getPublicKey(alice), ref: 'alice' })
    const aliceWatch = new DropWatch(alice, SMALL)
    aliceWatch.addPeer({ peerPublicKey: getPublicKey(bob) })
    const key = aliceWatch.sendKey(getPublicKey(bob), NOW)
    const wrap = createDrop({ content: 'hello bob' }, alice, getPublicKey(bob), key.publicKey, { now: () => NOW })

    const m = bobWatch.match(wrap, NOW)
    expect(m).not.toBeNull()
    expect(m!.peer.ref).toBe('alice')
    const opened = openDrop(wrap, m!.key.privateKey, bob)
    expect(opened.rumor.content).toBe('hello bob')
    // A relay replays: match says yes again (a tag is a tag), remember says no.
    expect(bobWatch.match(wrap, NOW)).not.toBeNull()
    expect(bobWatch.remember(opened.rumor.id)).toBe(true)
    expect(bobWatch.remember(opened.rumor.id)).toBe(false)
    // The reply direction has its own key, so two senders never share a tag.
    expect(bobWatch.sendKey(getPublicKey(alice), NOW).publicKey).not.toBe(key.publicKey)

    expect(bobWatch.match(createFiller({ now: () => NOW }), NOW)).toBeNull()
    const carolWatch = new DropWatch(carol, SMALL)
    carolWatch.addPeer({ peerPublicKey: getPublicKey(alice) })
    expect(carolWatch.match(wrap, NOW)).toBeNull()
  })
  it('accepts a drop sent in the previous or next epoch', () => {
    const bobWatch = new DropWatch(bob, { epochSeconds: 3600, lookbackEpochs: 1 })
    bobWatch.addPeer({ peerPublicKey: getPublicKey(alice) })
    const aliceWatch = new DropWatch(alice, { epochSeconds: 3600, lookbackEpochs: 1 })
    aliceWatch.addPeer({ peerPublicKey: getPublicKey(bob) })
    for (const skew of [-3600, 0, 3600]) {
      const key = aliceWatch.sendKey(getPublicKey(bob), NOW + skew)
      const wrap = createDrop({ content: 'x' }, alice, getPublicKey(bob), key.publicKey, { now: () => NOW + skew })
      expect(bobWatch.match(wrap, NOW)).not.toBeNull()
    }
    const far = aliceWatch.sendKey(getPublicKey(bob), NOW + 2 * 3600)
    const late = createDrop({ content: 'x' }, alice, getPublicKey(bob), far.publicKey, { now: () => NOW })
    expect(bobWatch.match(late, NOW)).toBeNull()
  })
  it('has (lookback + 2) epochs of keys per peer, and never the same tag twice', () => {
    const w = new DropWatch(bob, SMALL)
    w.addPeer({ peerPublicKey: getPublicKey(alice) })
    w.addPeer({ peerPublicKey: getPublicKey(carol) })
    expect(w.tags(NOW).length).toBe(2 * 4 * MAX_PER_EPOCH_PAIR)
    w.removePeer(getPublicKey(carol))
    expect(w.tags(NOW).length).toBe(4 * MAX_PER_EPOCH_PAIR)
    expect(new Set(w.tags(NOW)).size).toBe(w.tags(NOW).length)
  })
  it('builds the two pull filters, reaching back for the created_at jitter', () => {
    expect(broadcastFilter(CREATED_AT_JITTER + 100)).toEqual({ kinds: [1059], since: 100 })
    expect(broadcastFilter(5)).toEqual({ kinds: [1059], since: 0 })
    expect(taggedFilter(['aa'], CREATED_AT_JITTER + 5)).toEqual({ kinds: [1059], '#p': ['aa'], since: 5 })
  })
})

describe('Cadence', () => {
  it('emits exactly one wrap per slot, real first, filler otherwise', () => {
    const c = new Cadence({ intervalSeconds: 60, now: () => NOW, phaseSeconds: 0 })
    const key = getPublicKey(generateSecretKey())
    const seal = createDropSeal({ content: 'real' }, alice, getPublicKey(bob), { now: () => NOW })
    c.enqueue(seal, () => key)
    const first = c.due(NOW)
    expect(first!.tags.find((t) => t[0] === 'p')![1]).toBe(key)
    expect(c.pending).toBe(0)
    expect(c.due(NOW + 10)).toBeNull()
    const second = c.due(NOW + 60)
    expect(second).not.toBeNull()
    expect(second!.kind).toBe(1059)
    expect(second!.content.length).toBe(first!.content.length)
    expect(c.nextSlotAt(NOW + 61)).toBe(Math.floor((NOW + 61) / 60) * 60 + 60)
  })
})
