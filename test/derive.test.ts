import { describe, it, expect } from 'vitest'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'
import { getPublicKey } from 'nostr-tools/pure'
import { deriveDropKey, deriveDropWindow, ecdhX, pairIkm, epochIndexAt } from '../src/index.js'

// forgesworn-link vectors/rendezvous.json test-only keys and frozen intermediates.
const A = hexToBytes('4873374aacd9fbbdf073a29078b6cf9f27c137107530c521458d5d83118ae733')
const B = hexToBytes('d1be49b906d68d1228f291fec7f9e373e7fc282605ed63763ad03cd53aa853f0')
const EA = hexToBytes('daced59710de58fd5864e6821629414261d33addd59ceff45ffd2fba37dc5f4d')
const EB = hexToBytes('8f2b5a94f17bec15e6da441bad23accd776e67d408fdc1683f41e91596c5c42f')
const pubA = getPublicKey(A)
const pubB = getPublicKey(B)
const epubA = getPublicKey(EA)
const epubB = getPublicKey(EB)
const EPOCH = 498216

describe('pair material matches forgesworn-link rendezvous intermediates', () => {
  it('static_x', () => {
    expect(bytesToHex(ecdhX(A, pubB))).toBe('c72057e75e1141b61b80f222d78f17a312d1950da578bae510a28c0f53780177')
    expect(bytesToHex(ecdhX(B, pubA))).toBe('c72057e75e1141b61b80f222d78f17a312d1950da578bae510a28c0f53780177')
  })
  it('eph_x both', () => {
    expect(bytesToHex(ecdhX(EA, epubB))).toBe('3e0a7579af406dcd49cf4e477abeef28e52c9ac35c68e81c55ff3d6aad359aba')
  })
  it('eph_x one-sided (A carries)', () => {
    expect(bytesToHex(ecdhX(EA, pubB))).toBe('2456c0cdf38cd038890194e740b12b7dff52b59ca56ee2421120d0aa49fb177c')
  })
  it('ikm is case || static_x || eph_x', () => {
    const { ikm, case: c } = pairIkm({ myPrivateKey: A, peerPublicKey: pubB })
    expect(c).toBe('none')
    expect(ikm.length).toBe(65)
    expect(ikm[0]).toBe(0)
    expect(bytesToHex(ikm.subarray(33))).toBe('00'.repeat(32))
  })
})

describe('drop key derivation', () => {
  it('is symmetric with no ephemeral, and each direction has its own key', () => {
    const a = deriveDropKey({ myPrivateKey: A, peerPublicKey: pubB }, EPOCH, pubA)
    const b = deriveDropKey({ myPrivateKey: B, peerPublicKey: pubA }, EPOCH, pubA)
    expect(a.publicKey).toBe(b.publicKey)
    expect(bytesToHex(a.privateKey)).toBe(bytesToHex(b.privateKey))
    expect(getPublicKey(a.privateKey)).toBe(a.publicKey)
    const reverse = deriveDropKey({ myPrivateKey: A, peerPublicKey: pubB }, EPOCH, pubB)
    expect(reverse.publicKey).not.toBe(a.publicKey)
  })
  it('is symmetric with both ephemerals', () => {
    const a = deriveDropKey({ myPrivateKey: A, peerPublicKey: pubB, myEphemeralPrivateKey: EA, peerEphemeralPublicKey: epubB }, EPOCH, pubA)
    const b = deriveDropKey({ myPrivateKey: B, peerPublicKey: pubA, myEphemeralPrivateKey: EB, peerEphemeralPublicKey: epubA }, EPOCH, pubA)
    expect(a.case).toBe('both')
    expect(a.publicKey).toBe(b.publicKey)
  })
  it('is symmetric one-sided, and A-carries differs from B-carries', () => {
    const aCarries1 = deriveDropKey({ myPrivateKey: A, peerPublicKey: pubB, myEphemeralPrivateKey: EA }, EPOCH, pubA)
    const aCarries2 = deriveDropKey({ myPrivateKey: B, peerPublicKey: pubA, peerEphemeralPublicKey: epubA }, EPOCH, pubA)
    expect(aCarries1.case).toBe('one')
    expect(aCarries1.publicKey).toBe(aCarries2.publicKey)
    const bCarries = deriveDropKey({ myPrivateKey: A, peerPublicKey: pubB, peerEphemeralPublicKey: epubB }, EPOCH, pubA)
    expect(bCarries.publicKey).not.toBe(aCarries1.publicKey)
  })
  it('rotates per epoch and per case', () => {
    const e0 = deriveDropKey({ myPrivateKey: A, peerPublicKey: pubB }, EPOCH, pubA)
    const e1 = deriveDropKey({ myPrivateKey: A, peerPublicKey: pubB }, EPOCH + 1, pubA)
    const both = deriveDropKey({ myPrivateKey: A, peerPublicKey: pubB, myEphemeralPrivateKey: EA, peerEphemeralPublicKey: epubB }, EPOCH, pubA)
    expect(new Set([e0.publicKey, e1.publicKey, both.publicKey]).size).toBe(3)
  })
  it('window covers previous, current and next epoch', () => {
    const w = deriveDropWindow({ myPrivateKey: A, peerPublicKey: pubB }, 1793577600, pubA)
    expect(w.map((k) => k.epochIndex)).toEqual([EPOCH - 1, EPOCH, EPOCH + 1])
    expect(epochIndexAt(1793588888)).toBe(498219)
  })
})
