import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

/** secp256k1 group order. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

export const SALT = 'nostr-deaddrop/v1'
export const DEFAULT_EPOCH_SECONDS = 3600

/** Which ephemeral mix the pair used. Mirrors forgesworn-link RENDEZVOUS.md §2 case bytes. */
export type EphemeralCase = 'none' | 'one' | 'both'
const CASE_BYTE: Record<EphemeralCase, number> = { none: 0, one: 1, both: 2 }

export interface DropKey {
  /** 32-byte private scalar, held by both ends of the pair. */
  privateKey: Uint8Array
  /** x-only public key, hex. This is the `p` tag of a drop. */
  publicKey: string
  epochIndex: number
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

function xOnlyToCompressed(hex: string): Uint8Array {
  if (hex.length !== 64) throw new Error('expected 32-byte x-only public key hex')
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

export function epochIndexAt(unixSeconds: number, epochSeconds = DEFAULT_EPOCH_SECONDS): number {
  return Math.floor(unixSeconds / epochSeconds)
}

/**
 * Derive the drop keypair a pair shares for one epoch.
 *
 *   scalar = HKDF-SHA256(ikm, salt = "nostr-deaddrop/v1", info = "drop" || 0x00 || u64be(epoch), L = 32) mod n
 *
 * Both ends compute the same key with no ordering rule. The key is a delivery
 * capability: whoever holds it can decrypt the wrap layer and nothing inside it.
 */
export function deriveDropKey(m: PairMaterial, epochIndex: number): DropKey {
  const { ikm, case: c } = pairIkm(m)
  return deriveDropKeyFromIkm(ikm, c, epochIndex)
}

export function deriveDropKeyFromIkm(ikm: Uint8Array, c: EphemeralCase, epochIndex: number): DropKey {
  const info = new Uint8Array(4 + 1 + 8)
  info.set(utf8ToBytes('drop'), 0)
  info[4] = 0
  info.set(u64be(epochIndex), 5)
  let okm = hkdf(sha256, ikm, utf8ToBytes(SALT), info, 32)
  let scalar = bytesToBigInt(okm) % N
  // A zero scalar has probability 2^-256; loop rather than special-case it.
  let counter = 0
  while (scalar === 0n) {
    counter += 1
    const info2 = new Uint8Array(info.length + 1)
    info2.set(info)
    info2[info.length] = counter
    okm = hkdf(sha256, ikm, utf8ToBytes(SALT), info2, 32)
    scalar = bytesToBigInt(okm) % N
  }
  const privateKey = bigIntTo32(scalar)
  const publicKey = bytesToHex(secp256k1.getPublicKey(privateKey, true).subarray(1))
  return { privateKey, publicKey, epochIndex, case: c }
}

/** Drop keys for the previous, current and next epoch, so clock skew never drops a pair. */
export function deriveDropWindow(m: PairMaterial, unixSeconds: number, epochSeconds = DEFAULT_EPOCH_SECONDS): DropKey[] {
  const { ikm, case: c } = pairIkm(m)
  const e = epochIndexAt(unixSeconds, epochSeconds)
  return [e - 1, e, e + 1].map((i) => deriveDropKeyFromIkm(ikm, c, i))
}
