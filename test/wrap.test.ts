import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { createDrop, createFiller, openDrop, padToBucket, stripPadding, RumorTooLarge, deriveDropKey, DEFAULT_BUCKET } from '../src/index.js'

const alice = generateSecretKey()
const bob = generateSecretKey()
const pubBob = getPublicKey(bob)
const pubAlice = getPublicKey(alice)
const NOW = 1_800_000_000

function drop(content: string) {
  const key = deriveDropKey({ myPrivateKey: alice, peerPublicKey: pubBob }, 500000)
  const wrap = createDrop({ content, tags: [['p', pubBob]] }, alice, pubBob, key.publicKey, { now: () => NOW })
  return { key, wrap }
}

describe('padding', () => {
  it('pads a rumor to exactly the bucket', () => {
    const padded = padToBucket({ kind: 14, content: 'hello', created_at: NOW, tags: [] }, 512)
    const rumor = { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), ...padded }
    expect(Buffer.byteLength(JSON.stringify(rumor), 'utf8')).toBe(512)
  })
  it('replaces an existing pad tag instead of stacking', () => {
    const once = padToBucket({ kind: 14, content: 'x', created_at: NOW, tags: [] }, 300)
    const twice = padToBucket(once, 300)
    expect(twice.tags!.filter((t) => t[0] === 'pad').length).toBe(1)
  })
  it('refuses a rumor bigger than the bucket', () => {
    expect(() => padToBucket({ kind: 14, content: 'x'.repeat(600), created_at: NOW, tags: [] }, 512)).toThrow(RumorTooLarge)
  })
})

describe('drops', () => {
  it('round-trips to the real recipient through the drop key', () => {
    const { key, wrap } = drop('meet at the lane at eight')
    expect(wrap.kind).toBe(1059)
    expect(wrap.tags.find((t) => t[0] === 'p')![1]).toBe(key.publicKey)
    expect(wrap.pubkey).not.toBe(pubAlice)
    expect(verifyEvent(wrap)).toBe(true)
    const opened = openDrop(wrap, key.privateKey, bob)
    expect(opened.seal.pubkey).toBe(pubAlice)
    expect(opened.rumor.pubkey).toBe(pubAlice)
    expect(stripPadding(opened.rumor).content).toBe('meet at the lane at eight')
    expect(stripPadding(opened.rumor).tags.some((t) => t[0] === 'pad')).toBe(false)
  })
  it('cannot be opened with the wrong drop key or the wrong recipient', () => {
    const { key, wrap } = drop('hi')
    expect(() => openDrop(wrap, generateSecretKey(), bob)).toThrow()
    expect(() => openDrop(wrap, key.privateKey, generateSecretKey())).toThrow()
  })
  it('carries the same expiration whether real or filler', () => {
    const { wrap } = drop('hi')
    const filler = createFiller({ now: () => NOW })
    const exp = (e: typeof wrap) => e.tags.find((t) => t[0] === 'expiration')![1]
    expect(exp(wrap)).toBe(exp(filler))
  })
  it('real and filler wraps are the same size', () => {
    const sizes = new Set<number>()
    for (const content of ['', 'a', 'a much longer message that still fits inside the bucket easily']) {
      sizes.add(drop(content).wrap.content.length)
    }
    for (let i = 0; i < 3; i++) sizes.add(createFiller({ now: () => NOW }).content.length)
    expect(sizes.size).toBe(1)
  })
  it('names the recipient nowhere on the wire', () => {
    const { wrap } = drop('hi')
    const wire = JSON.stringify(wrap)
    expect(wire.includes(pubBob)).toBe(false)
    expect(wire.includes(pubAlice)).toBe(false)
  })
  it('uses the default bucket when none is given', () => {
    const key = deriveDropKey({ myPrivateKey: alice, peerPublicKey: pubBob }, 1)
    const wrap = createDrop({ content: 'x' }, alice, pubBob, key.publicKey, { now: () => NOW })
    const opened = openDrop(wrap, key.privateKey, bob)
    expect(Buffer.byteLength(JSON.stringify(opened.rumor), 'utf8')).toBe(DEFAULT_BUCKET)
  })
})
