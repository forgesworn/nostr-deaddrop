import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

/** secp256k1 group order. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

export const SALT = 'nostr-deaddrop/v1'
export const DEFAULT_EPOCH_SECONDS = 3600
/**
 * How many drops one sender may post on one pair in one epoch. Every drop
 * gets its own key, so a relay never sees a tag twice; a receiver derives
 * this many keys per epoch per peer. 64 an hour is a busy chat; a longer
 * burst waits for the next epoch.
 */
export const MAX_PER_EPOCH_PAIR = 64
/** The same for one member of a room. Rooms have many senders, so each gets fewer. */
export const MAX_PER_EPOCH_ROOM = 16
/** How far back a receiver derives keys by default: two days, the same distance the created_at jitter reaches. */
export const DEFAULT_LOOKBACK_SECONDS = 2 * 24 * 3600

/** Which ephemeral mix the pair used. Mirrors forgesworn-link RENDEZVOUS.md §2 case bytes. `room` is a room key, case byte 0x10. */
export type EphemeralCase = 'none' | 'one' | 'both' | 'room'
const CASE_BYTE: Record<EphemeralCase, number> = { none: 0, one: 1, both: 2, room: 0x10 }

export interface DropKey {
  /** 32-byte private scalar, held by both ends of the pair. */
  privateKey: Uint8Array
  /** x-only public key, hex. This is the `p` tag of a drop. */
  publicKey: string
  epochIndex: number
  /** Which of the epoch's keys this is. A sender never uses one twice in an epoch. */
  counter: number
  case: EphemeralCase
}

export interface PairMaterial {
  /** My static Nostr private key. */
  myPrivateKey: Uint8Array
  /** Peer's static Nostr public key, x-only hex. */
  peerPublicKey: string
  /** My ephemeral private key from my current card, if I carry one. */
  myEphemeralPrivateKey?: Uint8Array
  /** Peer's ephemeral public key from their current card, x-only hex, if they carry one. */
  peerEphemeralPublicKey?: string
}

const HEX64 = /^[0-9a-f]{64}$/

function xOnlyToCompressed(hex: string): Uint8Array {
  if (typeof hex !== 'string' || !HEX64.test(hex)) throw new Error('expected 32-byte x-only public key as lower-case hex')
  return hexToBytes('02' + hex)
}

/** x-coordinate of ECDH(priv, pub). Parity of the public key does not change x. */
export function ecdhX(privateKey: Uint8Array, peerPublicKeyXOnly: string): Uint8Array {
  return Uint8Array.from(secp256k1.getSharedSecret(privateKey, xOnlyToCompressed(peerPublicKeyXOnly), true).subarray(1, 33))
}

function bytesToBigInt(b: Uint8Array): bigint {
  return BigInt('0x' + bytesToHex(b))
}

function bigIntTo32(n: bigint): Uint8Array {
  return hexToBytes(n.toString(16).padStart(64, '0'))
}

function u64be(n: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n))
  return out
}

/**
 * Input key material for a pair, byte-identical to forgesworn-link's rendezvous ikm:
 * `case_byte || static_x || eph_x` (65 bytes). A pair that already holds Link cards
 * derives its drop keys from exactly the material it uses for Link tags.
 */
export function pairIkm(m: PairMaterial): { ikm: Uint8Array; case: EphemeralCase } {
  const staticX = ecdhX(m.myPrivateKey, m.peerPublicKey)
  let ephX: Uint8Array = new Uint8Array(32)
  let c: EphemeralCase = 'none'
  if (m.myEphemeralPrivateKey && m.peerEphemeralPublicKey) {
    ephX = ecdhX(m.myEphemeralPrivateKey, m.peerEphemeralPublicKey)
    c = 'both'
  } else if (m.myEphemeralPrivateKey) {
    // I carry, the peer does not: my ephemeral against the peer's static key.
    ephX = ecdhX(m.myEphemeralPrivateKey, m.peerPublicKey)
    c = 'one'
  } else if (m.peerEphemeralPublicKey) {
    // The peer carries, I do not: my static key against their ephemeral.
    ephX = ecdhX(m.myPrivateKey, m.peerEphemeralPublicKey)
    c = 'one'
  }
  const ikm = new Uint8Array(65)
  ikm[0] = CASE_BYTE[c]
  ikm.set(staticX, 1)
  ikm.set(ephX, 33)
  return { ikm, case: c }
}

/**
 * Every ikm a pair could be using right now, given the material this side
 * holds. While cards are changing hands one side may have the other's
 * ephemeral before the other has theirs, so the two sides derive different
 * cases; a receiver that watches all of them misses nothing in between.
 * The first entry is the case this side would send on.
 */
export function pairIkmCases(m: PairMaterial): { ikm: Uint8Array; case: EphemeralCase }[] {
  const primary = pairIkm(m)
  const out = [primary]
  const seen = new Set([bytesToHex(primary.ikm)])
  const variants: PairMaterial[] = [
    { myPrivateKey: m.myPrivateKey, peerPublicKey: m.peerPublicKey },
    { myPrivateKey: m.myPrivateKey, peerPublicKey: m.peerPublicKey, myEphemeralPrivateKey: m.myEphemeralPrivateKey },
    { myPrivateKey: m.myPrivateKey, peerPublicKey: m.peerPublicKey, peerEphemeralPublicKey: m.peerEphemeralPublicKey },
  ]
  for (const v of variants) {
    const r = pairIkm(v)
    const h = bytesToHex(r.ikm)
    if (!seen.has(h)) { seen.add(h); out.push(r) }
  }
  return out
}

export function epochIndexAt(unixSeconds: number, epochSeconds = DEFAULT_EPOCH_SECONDS): number {
  if (!Number.isFinite(unixSeconds) || !(epochSeconds > 0)) throw new Error('bad clock')
  return Math.floor(unixSeconds / epochSeconds)
}

/**
 * Derive one drop keypair: one epoch, one direction, one counter.
 *
 *   scalar = HKDF-SHA256(ikm, salt = "nostr-deaddrop/v1",
 *                        info = "drop" || 0x00 || u64be(epoch) || sender_pubkey || u16be(counter), L = 32) mod n
 *
 * `sender` is the x-only public key of whoever sends on this key, so the two
 * directions of a pair use different keys. `counter` makes every drop in an
 * epoch a different key, so a relay never sees the same tag twice and cannot
 * tell a second message from a filler. Both ends compute every key with no
 * ordering rule. The key is a delivery capability: whoever holds it can
 * decrypt the wrap layer and nothing inside it.
 */
export function deriveDropKey(m: PairMaterial, epochIndex: number, sender: string, counter = 0): DropKey {
  const { ikm, case: c } = pairIkm(m)
  return deriveDropKeyFromIkm(ikm, c, epochIndex, sender, counter)
}

export function deriveDropKeyFromIkm(ikm: Uint8Array, c: EphemeralCase, epochIndex: number, sender: string, counter = 0): DropKey {
  if (!(ikm instanceof Uint8Array) || ikm.length !== 65) throw new Error('ikm must be 65 bytes')
  if (!Number.isSafeInteger(epochIndex) || epochIndex < 0) throw new Error('epoch index must be a non-negative integer')
  if (!Number.isInteger(counter) || counter < 0 || counter > 0xffff) throw new Error('counter must be an integer from 0 to 65535')
  if (typeof sender !== 'string' || !HEX64.test(sender)) throw new Error('sender must be a 32-byte x-only public key as lower-case hex')
  const senderBytes = hexToBytes(sender)
  const info = new Uint8Array(4 + 1 + 8 + 32 + 2)
  info.set(utf8ToBytes('drop'), 0)
  info[4] = 0
  info.set(u64be(epochIndex), 5)
  info.set(senderBytes, 13)
  info[45] = counter >> 8
  info[46] = counter & 0xff
  let okm = hkdf(sha256, ikm, utf8ToBytes(SALT), info, 32)
  let scalar = bytesToBigInt(okm) % N
  // A zero scalar has probability 2^-256; loop rather than special-case it.
  let retry = 0
  while (scalar === 0n) {
    retry += 1
    const info2 = new Uint8Array(info.length + 1)
    info2.set(info)
    info2[info.length] = retry
    okm = hkdf(sha256, ikm, utf8ToBytes(SALT), info2, 32)
    scalar = bytesToBigInt(okm) % N
  }
  const privateKey = bigIntTo32(scalar)
  const publicKey = bytesToHex(secp256k1.getPublicKey(privateKey, true).subarray(1))
  return { privateKey, publicKey, epochIndex, counter, case: c }
}

/** Every key one sender may use in one epoch. */
export function deriveDropEpoch(ikm: Uint8Array, c: EphemeralCase, epochIndex: number, sender: string, max: number): DropKey[] {
  const out: DropKey[] = []
  for (let k = 0; k < max; k++) out.push(deriveDropKeyFromIkm(ikm, c, epochIndex, sender, k))
  return out
}

/** Every key a given sender may use across the previous, current and next epoch. */
export function deriveDropWindow(m: PairMaterial, unixSeconds: number, sender: string, epochSeconds = DEFAULT_EPOCH_SECONDS, max = MAX_PER_EPOCH_PAIR): DropKey[] {
  const { ikm, case: c } = pairIkm(m)
  const e = epochIndexAt(unixSeconds, epochSeconds)
  return [e - 1, e, e + 1].flatMap((i) => (i < 0 ? [] : deriveDropEpoch(ikm, c, i, sender, max)))
}
