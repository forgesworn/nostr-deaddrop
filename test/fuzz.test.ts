import { describe, it, expect } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { NostrEvent } from 'nostr-tools/pure'
import { createDrop, openDrop, deriveDropKey, DropWatch, createRoomDrop, openRoomDrop, deriveRoomDropKey, padToBucket } from '../src/index.js'

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 } }
const alice = generateSecretKey(), bob = generateSecretKey()
const pubA = getPublicKey(alice), pubB = getPublicKey(bob)
const NOW = 1_800_000_000
const N = 600

function flipString(s: string, r: () => number): string {
  const i = Math.floor(r() * s.length)
  const c = String.fromCharCode(s.charCodeAt(i) ^ (1 << Math.floor(r() * 6)))
  return s.slice(0, i) + c + s.slice(i + 1)
}

describe('fuzz: pair drops', () => {
  const key = deriveDropKey({ myPrivateKey: alice, peerPublicKey: pubB }, 500000, pubA)
  const wrap = createDrop({ content: 'hello' }, alice, pubB, key.publicKey, { now: () => NOW })
  it('a mutated wrap opens only when the mutation changes nothing, and then to the same rumor', () => {
    const r = rng(11)
    const original = JSON.stringify(openDrop(wrap, key.privateKey, bob).rumor)
    let accepted = 0
    for (let i = 0; i < N; i++) {
      const m: NostrEvent = { ...wrap, tags: wrap.tags.map((t) => [...t]) }
      const op = Math.floor(r() * 4)
      if (op === 0) m.content = flipString(m.content, r)
      else if (op === 1) m.content = m.content.slice(0, Math.floor(r() * m.content.length))
      else if (op === 2) m.pubkey = flipString(m.pubkey, r)
      else m.tags = []
      let out: string | undefined
      try { out = JSON.stringify(openDrop(m, key.privateKey, bob).rumor) } catch (e) { expect(e).toBeInstanceOf(Error) }
      if (out !== undefined) {
        accepted++
        expect(out).toBe(original)
        // The only mutations that open are ones that decode to the same
        // bytes: a hex-case flip in the signer key, a base64 slack bit, or a
        // dropped trailing padding character.
        expect(Buffer.from(m.content, 'base64').equals(Buffer.from(wrap.content, 'base64'))).toBe(true)
        expect(m.pubkey.toLowerCase()).toBe(wrap.pubkey.toLowerCase())
      }
    }
    // A quarter to a third of single-bit flips land on a hex case bit, a
    // base64 slack bit or a padding character; more than that would mean a
    // mutation that changed bytes was accepted, which the checks above forbid.
    expect(accepted).toBeLessThan(N / 3)
  })
  it('random events are never matched by a watch', () => {
    const r = rng(12)
    const w = new DropWatch(bob)
    w.addPeer({ peerPublicKey: pubA })
    for (let i = 0; i < N; i++) {
      const ev = finalizeEvent({ kind: r() < 0.9 ? 1059 : Math.floor(r() * 40000), created_at: NOW, tags: [['p', getPublicKey(generateSecretKey())], ['x', 'y'.repeat(Math.floor(r() * 50))]], content: 'z'.repeat(Math.floor(r() * 200)) }, generateSecretKey())
      expect(w.match(ev, NOW)).toBeNull()
    }
    const junk = { kind: 1059, tags: 'not-an-array' } as unknown as NostrEvent
    expect(() => w.match({ ...junk, tags: [] } as NostrEvent, NOW)).not.toThrow()
  })
  it('padToBucket refuses oversize and never produces a wrong size', () => {
    const r = rng(13)
    for (let i = 0; i < 300; i++) {
      const content = 'x'.repeat(Math.floor(r() * 700))
      const bucket = 256 + Math.floor(r() * 512)
      try {
        const p = padToBucket({ kind: 14, created_at: NOW, tags: [], content }, bucket)
        const rumor = { id: '0'.repeat(64), pubkey: '0'.repeat(64), ...p }
        expect(Buffer.byteLength(JSON.stringify(rumor), 'utf8')).toBe(bucket)
      } catch (e) {
        expect(String(e)).toMatch(/bucket/)
      }
    }
  })
})

describe('fuzz: room drops', () => {
  const roomKey = new Uint8Array(32).fill(5)
  const key = deriveRoomDropKey(roomKey, 500000, pubA)
  const inner = finalizeEvent({ kind: 1460, created_at: NOW, tags: [['d', 'ab'.repeat(32)]], content: 'x' }, alice)
  const drop = createRoomDrop(inner, key.publicKey, { now: () => NOW })
  it('a mutated room drop opens only to the identical inner event, if at all', () => {
    const r = rng(14)
    const original = JSON.stringify(openRoomDrop(drop, key.privateKey))
    let accepted = 0
    for (let i = 0; i < N; i++) {
      const m: NostrEvent = { ...drop }
      if (r() < 0.5) m.content = flipString(m.content, r)
      else m.pubkey = flipString(m.pubkey, r)
      let out: string | undefined
      try { out = JSON.stringify(openRoomDrop(m, key.privateKey)) } catch (e) { expect(e).toBeInstanceOf(Error) }
      if (out !== undefined) { accepted++; expect(out).toBe(original) }
    }
    expect(accepted).toBeLessThan(N / 4)
    expect(() => openRoomDrop(drop, generateSecretKey())).toThrow()
  })
})
