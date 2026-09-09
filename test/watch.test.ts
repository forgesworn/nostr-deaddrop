import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { DropWatch, createDrop, createFiller, openDrop, broadcastFilter, taggedFilter, Cadence } from '../src/index.js'

const alice = generateSecretKey()
const bob = generateSecretKey()
const carol = generateSecretKey()
const NOW = 1_800_000_000

describe('DropWatch', () => {
  it('matches a drop from a known peer and ignores everything else', () => {
    const bobWatch = new DropWatch(bob)
    bobWatch.addPeer({ peerPublicKey: getPublicKey(alice), ref: 'alice' })
    const aliceWatch = new DropWatch(alice)
    aliceWatch.addPeer({ peerPublicKey: getPublicKey(bob) })
    const key = aliceWatch.sendKey(getPublicKey(bob), NOW)
    const wrap = createDrop({ content: 'hello bob' }, alice, getPublicKey(bob), key.publicKey, { now: () => NOW })

    const m = bobWatch.match(wrap, NOW)
    expect(m).not.toBeNull()
    expect(m!.peer.ref).toBe('alice')
    const opened = openDrop(wrap, m!.key.privateKey, bob)
    expect(opened.rumor.content).toBe('hello bob')

    expect(bobWatch.match(createFiller({ now: () => NOW }), NOW)).toBeNull()
    const carolWatch = new DropWatch(carol)
    carolWatch.addPeer({ peerPublicKey: getPublicKey(alice) })
    expect(carolWatch.match(wrap, NOW)).toBeNull()
  })
  it('accepts a drop sent in the previous or next epoch', () => {
    const bobWatch = new DropWatch(bob, 3600)
    bobWatch.addPeer({ peerPublicKey: getPublicKey(alice) })
    const aliceWatch = new DropWatch(alice, 3600)
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
  it('has three tags per peer', () => {
    const w = new DropWatch(bob)
    w.addPeer({ peerPublicKey: getPublicKey(alice) })
    w.addPeer({ peerPublicKey: getPublicKey(carol) })
    expect(w.tags(NOW).length).toBe(6)
    w.removePeer(getPublicKey(carol))
    expect(w.tags(NOW).length).toBe(3)
  })
  it('builds the two pull filters', () => {
    expect(broadcastFilter(100)).toEqual({ kinds: [1059], since: 100 })
    expect(taggedFilter(['aa'], 5)).toEqual({ kinds: [1059], '#p': ['aa'], since: 5 })
  })
})

describe('Cadence', () => {
  it('emits exactly one wrap per slot, real first, filler otherwise', () => {
    const c = new Cadence({ intervalSeconds: 60, now: () => NOW })
    const key = getPublicKey(generateSecretKey())
    const real = createDrop({ content: 'real' }, alice, getPublicKey(bob), key, { now: () => NOW })
    c.enqueue(real)
    const first = c.due(NOW)
    expect(first).toBe(real)
    expect(c.due(NOW + 10)).toBeNull()
    const second = c.due(NOW + 60)
    expect(second).not.toBeNull()
    expect(second!.kind).toBe(1059)
    expect(second!.content.length).toBe(real.content.length)
    expect(c.nextSlotAt(NOW + 61)).toBe(Math.floor((NOW + 61) / 60) * 60 + 60)
  })
})
