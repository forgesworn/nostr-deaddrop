import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import type { NostrEvent } from 'nostr-tools/pure'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { deriveDropKeyFromIkm, epochIndexAt, DEFAULT_EPOCH_SECONDS, type DropKey } from './derive.js'
import { DEFAULT_ROOM_BUCKET, DEFAULT_TTL_SECONDS, GIFT_WRAP_KIND, PAD_TAG, RumorTooLarge, randomPast, wrapTags, type DropOptions } from './wrap.js'

/**
 * Drops for a room: everyone who holds the room key derives every member's
 * drop key per epoch, so a room's events can ride kind 1059 with no stable
 * room identifier on any relay. Keys are per member as well as per epoch,
 * so a relay never sees several senders post to one tag in one hour, which
 * would give away the room's size. The inner event is already encrypted to the room
 * key by the room's own protocol; this layer only hides that it exists.
 *
 * The ikm keeps the 65-byte shape of the pair derivation with its own case
 * byte, so a room key and a pair secret can never derive the same drop key:
 *
 *   ikm = 0x10 || HKDF-SHA256(roomKey, salt = "nostr-deaddrop/room/v1", info = "ikm", 32) || 32 zero bytes
 */
export const ROOM_CASE_BYTE = 0x10
const ROOM_SALT = 'nostr-deaddrop/room/v1'

export function roomIkm(roomKey: Uint8Array): Uint8Array {
  if (roomKey.length !== 32) throw new Error('room key must be 32 bytes')
  const ikm = new Uint8Array(65)
  ikm[0] = ROOM_CASE_BYTE
  ikm.set(hkdf(sha256, roomKey, utf8ToBytes(ROOM_SALT), utf8ToBytes('ikm'), 32), 1)
  return ikm
}

/** The drop key one member sends on in one epoch. `member` is the member's x-only pubkey as the room knows it. */
export function deriveRoomDropKey(roomKey: Uint8Array, epochIndex: number, member: string): DropKey {
  return deriveDropKeyFromIkm(roomIkm(roomKey), 'none', epochIndex, member)
}

export function deriveRoomDropWindow(roomKey: Uint8Array, unixSeconds: number, member: string, epochSeconds = DEFAULT_EPOCH_SECONDS): DropKey[] {
  const ikm = roomIkm(roomKey)
  const e = epochIndexAt(unixSeconds, epochSeconds)
  return [e - 1, e, e + 1].map((i) => deriveDropKeyFromIkm(ikm, 'none', i, member))
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
function randomAlnum(n: number): string {
  const b = randomBytes(n)
  let s = ''
  for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length]
  return s
}

/**
 * The plaintext inside a room drop: the signed inner event and padding, so
 * every drop for a room serialises to exactly `bucket` bytes whatever the
 * inner event says.
 */
function roomPlaintext(inner: NostrEvent, bucket: number): string {
  const probe = JSON.stringify({ e: inner, [PAD_TAG]: '' })
  const base = Buffer.byteLength(probe, 'utf8')
  if (base > bucket) throw new RumorTooLarge(base, bucket)
  return JSON.stringify({ e: inner, [PAD_TAG]: randomAlnum(bucket - base) })
}

/**
 * Wrap a signed room event to the room's drop key. Nothing is re-signed and
 * nothing is sealed: the inner event carries its own signature and its own
 * room-key encryption, and the drop hides its kind, its tags and its author
 * from the relay.
 */
export function createRoomDrop(inner: NostrEvent, dropPublicKey: string, opts: DropOptions = {}): NostrEvent {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const bucket = opts.bucket ?? DEFAULT_ROOM_BUCKET
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS
  const t = now()
  const randomKey = generateSecretKey()
  const ck = nip44.getConversationKey(randomKey, dropPublicKey)
  return finalizeEvent(
    {
      kind: GIFT_WRAP_KIND,
      content: nip44.encrypt(roomPlaintext(inner, bucket), ck),
      created_at: randomPast(t),
      tags: wrapTags(dropPublicKey, t, ttl),
    },
    randomKey,
  )
}

/** Open a room drop and return the signed inner event, verified. */
export function openRoomDrop(wrap: NostrEvent, dropPrivateKey: Uint8Array): NostrEvent {
  if (wrap.kind !== GIFT_WRAP_KIND) throw new Error('not a gift wrap')
  const ck = nip44.getConversationKey(dropPrivateKey, wrap.pubkey)
  const parsed = JSON.parse(nip44.decrypt(wrap.content, ck)) as { e?: NostrEvent }
  const inner = parsed.e
  if (!inner || typeof inner !== 'object') throw new Error('no inner event')
  if (!verifyEvent(inner)) throw new Error('bad inner signature')
  return inner
}

/**
 * A filler for a room's empty slot: an inner event nobody can decrypt,
 * signed by a throwaway key, wrapped to a throwaway drop key, the same size
 * as a real room drop for the same bucket.
 */
export function createRoomFiller(innerKind: number, opts: DropOptions = {}): NostrEvent {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const t = now()
  // A plausible inner event: the room's real kind, a random d tag, and a
  // NIP-44 ciphertext of nothing under a key that is thrown away.
  const inner = finalizeEvent(
    {
      kind: innerKind,
      created_at: randomPast(t),
      tags: [['d', bytesToHex(randomBytes(32))]],
      content: nip44.encrypt('0', nip44.getConversationKey(generateSecretKey(), getPublicKey(generateSecretKey()))),
    },
    generateSecretKey(),
  )
  return createRoomDrop(inner, getPublicKey(generateSecretKey()), opts)
}
