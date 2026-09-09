import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'
import { deriveDropKey, pairIkm, deriveRoomDropKey, roomIkm } from '../src/index.js'
import { hexToBytes as h2b } from '@noble/hashes/utils.js'

const v = JSON.parse(readFileSync(new URL('../vectors/deaddrop.json', import.meta.url), 'utf8'))
const k = v.testOnlyKeys

describe('known-answer vectors', () => {
  for (const c of v.cases) {
    it(c.name, () => {
      const m: any = { myPrivateKey: hexToBytes(k.nostrAPrivHex), peerPublicKey: k.nostrBPubXOnly }
      if (c.case === 'both') { m.myEphemeralPrivateKey = hexToBytes(k.ephAPrivHex); m.peerEphemeralPublicKey = k.ephBPubXOnly }
      if (c.case === 'one') { m.myEphemeralPrivateKey = hexToBytes(k.ephAPrivHex) }
      expect(bytesToHex(pairIkm(m).ikm)).toBe(c.ikmHex)
      const d = deriveDropKey(m, c.epochIndex, c.sender, c.counter)
      expect(bytesToHex(d.privateKey)).toBe(c.dropPrivHex)
      expect(d.publicKey).toBe(c.dropPubXOnly)
    })
  }
  it('every case yields a distinct key', () => {
    expect(new Set(v.cases.map((c: any) => c.dropPubXOnly)).size).toBe(v.cases.length)
  })
  for (const c of v.roomCases) {
    it(c.name, () => {
      expect(bytesToHex(roomIkm(h2b(c.roomKeyHex)))).toBe(c.ikmHex)
      const d = deriveRoomDropKey(h2b(c.roomKeyHex), c.epochIndex, c.member, c.counter)
      expect(bytesToHex(d.privateKey)).toBe(c.dropPrivHex)
      expect(d.publicKey).toBe(c.dropPubXOnly)
    })
  }
})
