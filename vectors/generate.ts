import { writeFileSync } from 'node:fs'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'
import { getPublicKey } from 'nostr-tools/pure'
import { deriveDropKey, pairIkm, SALT, DEFAULT_EPOCH_SECONDS } from '../src/index.js'

// The same test-only keys as forgesworn-link vectors/rendezvous.json, so a
// Link implementation can check its ikm against ours byte for byte.
const A = hexToBytes('4873374aacd9fbbdf073a29078b6cf9f27c137107530c521458d5d83118ae733')
const B = hexToBytes('d1be49b906d68d1228f291fec7f9e373e7fc282605ed63763ad03cd53aa853f0')
const EA = hexToBytes('daced59710de58fd5864e6821629414261d33addd59ceff45ffd2fba37dc5f4d')
const EB = hexToBytes('8f2b5a94f17bec15e6da441bad23accd776e67d408fdc1683f41e91596c5c42f')
const EPOCH = 498216

const cases = [
  { name: 'no-ephemeral-A-sends', m: { myPrivateKey: A, peerPublicKey: getPublicKey(B) }, epoch: EPOCH, sender: getPublicKey(A) },
  { name: 'no-ephemeral-B-sends', m: { myPrivateKey: A, peerPublicKey: getPublicKey(B) }, epoch: EPOCH, sender: getPublicKey(B) },
  { name: 'both-ephemeral', m: { myPrivateKey: A, peerPublicKey: getPublicKey(B), myEphemeralPrivateKey: EA, peerEphemeralPublicKey: getPublicKey(EB) }, epoch: EPOCH, sender: getPublicKey(A) },
  { name: 'one-ephemeral-A-carries', m: { myPrivateKey: A, peerPublicKey: getPublicKey(B), myEphemeralPrivateKey: EA }, epoch: EPOCH, sender: getPublicKey(A) },
  { name: 'next-epoch-differs', m: { myPrivateKey: A, peerPublicKey: getPublicKey(B) }, epoch: EPOCH + 1, sender: getPublicKey(A) },
]

const out = {
  format: 'nostr-deaddrop-known-answer-v1',
  saltUtf8: SALT,
  info: '"drop" || 0x00 || u64be(epoch_index) || sender_pubkey (32 bytes)',
  ikm: 'case_byte || static_x || eph_x (65 bytes), as forgesworn-link RENDEZVOUS.md §2',
  epochSeconds: DEFAULT_EPOCH_SECONDS,
  testOnlyKeys: {
    nostrAPrivHex: bytesToHex(A), nostrAPubXOnly: getPublicKey(A),
    nostrBPrivHex: bytesToHex(B), nostrBPubXOnly: getPublicKey(B),
    ephAPrivHex: bytesToHex(EA), ephAPubXOnly: getPublicKey(EA),
    ephBPrivHex: bytesToHex(EB), ephBPubXOnly: getPublicKey(EB),
  },
  cases: cases.map(({ name, m, epoch, sender }) => {
    const { ikm, case: c } = pairIkm(m)
    const k = deriveDropKey(m, epoch, sender)
    return { name, caseByte: ikm[0], case: c, ikmHex: bytesToHex(ikm), epochIndex: epoch, sender, dropPrivHex: bytesToHex(k.privateKey), dropPubXOnly: k.publicKey }
  }),
}
writeFileSync(new URL('./deaddrop.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
console.log(`wrote ${out.cases.length} cases`)
