import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { createRumor, createSeal } from 'nostr-tools/nip59'
import * as nip44 from 'nostr-tools/nip44'
import type { NostrEvent, UnsignedEvent } from 'nostr-tools/pure'
import { randomBytes } from '@noble/hashes/utils.js'

export const GIFT_WRAP_KIND = 1059
export const PAD_TAG = 'pad'
/** Default rumor size in bytes of serialised JSON. Every rumor is padded to exactly this. */
export const DEFAULT_BUCKET = 2048
/**
 * Default time-to-live: none. Ordinary NIP-17 clients do not set an
 * `expiration` tag, so a quiet wrap that carried one would stand out from
 * the crowd it hides in. Set `ttlSeconds` only on a relay you run yourself.
 */
export const DEFAULT_TTL_SECONDS: number | undefined = undefined

export interface DropOptions {
  /** Serialised rumor length every drop is padded to. Same for real and filler. */
  bucket?: number
  /** NIP-40 expiration, seconds from now, same for real and filler. Off by
   *  default so the wrap looks like every other NIP-17 wrap. */
  ttlSeconds?: number
  /** Override the clock (tests). */
  now?: () => number
}

export class RumorTooLarge extends Error {
  constructor(public readonly length: number, public readonly bucket: number) {
    super(`rumor serialises to ${length} bytes, bucket is ${bucket}`)
  }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function randomAlnum(n: number): string {
  const b = randomBytes(n)
  let s = ''
  for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length]
  return s
}

/** NIP-59 randomises created_at up to two days into the past. CSPRNG, not Math.random. */
export function randomPast(now: number): number {
  const b = randomBytes(4)
  const r = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0
  return now - Math.floor((r / 0x100000000) * 2 * 24 * 3600)
}

/**
 * Pad an unsigned event so that, once it becomes a rumor (id and pubkey filled),
 * its JSON serialisation is exactly `bucket` bytes. Padding is a `pad` tag of
 * JSON-safe characters, which receivers ignore.
 */
export function padToBucket(event: Partial<UnsignedEvent>, bucket = DEFAULT_BUCKET): Partial<UnsignedEvent> {
  const tags = (event.tags ?? []).filter((t) => t[0] !== PAD_TAG)
  const probe = {
    id: '0'.repeat(64),
    pubkey: '0'.repeat(64),
    created_at: event.created_at ?? 0,
    kind: event.kind ?? 14,
    tags: [...tags, [PAD_TAG, '']],
    content: event.content ?? '',
  }
  const base = Buffer.byteLength(JSON.stringify(probe), 'utf8')
  if (base > bucket) throw new RumorTooLarge(base, bucket)
  return { ...event, tags: [...tags, [PAD_TAG, randomAlnum(bucket - base)]] }
}

/**
 * Build a drop: rumor padded to the bucket, sealed by the sender to the real
 * recipient, wrapped to the pair's drop key. The wrap's `p` tag is the drop
 * key, so no relay sees either identity.
 */
export function createDrop(
  event: Partial<UnsignedEvent>,
  senderPrivateKey: Uint8Array,
  recipientPublicKey: string,
  dropPublicKey: string,
  opts: DropOptions = {},
): NostrEvent {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const bucket = opts.bucket ?? DEFAULT_BUCKET
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS
  const t = now()
  const padded = padToBucket({ created_at: t, kind: 14, ...event }, bucket)
  const rumor = createRumor(padded, senderPrivateKey)
  const seal = createSeal(rumor, senderPrivateKey, recipientPublicKey)
  return wrapToDrop(seal, dropPublicKey, t, ttl)
}

export function wrapTags(dropPublicKey: string, now: number, ttl: number | undefined): string[][] {
  return ttl === undefined ? [['p', dropPublicKey]] : [['p', dropPublicKey], ['expiration', String(now + ttl)]]
}

function wrapToDrop(seal: NostrEvent, dropPublicKey: string, now: number, ttl: number | undefined): NostrEvent {
  const randomKey = generateSecretKey()
  const ck = nip44.getConversationKey(randomKey, dropPublicKey)
  return finalizeEvent(
    {
      kind: GIFT_WRAP_KIND,
      content: nip44.encrypt(JSON.stringify(seal), ck),
      created_at: randomPast(now),
      tags: wrapTags(dropPublicKey, now, ttl),
    },
    randomKey,
  )
}

/**
 * A filler drop for an empty slot: a real rumor with empty content, sealed by a
 * throwaway sender to a throwaway recipient, wrapped to a throwaway drop key.
 * Byte-for-byte the same shape and size as a real drop. Nobody can open it.
 */
export function createFiller(opts: DropOptions = {}): NostrEvent {
  const sender = generateSecretKey()
  const recipient = getPublicKey(generateSecretKey())
  const drop = getPublicKey(generateSecretKey())
  return createDrop({ content: '' }, sender, recipient, drop, opts)
}

export interface Opened {
  rumor: UnsignedEvent & { id: string }
  seal: NostrEvent
}

/**
 * Open a drop with the pair's drop private key and the recipient's own key.
 * Verifies the seal signature and that the rumor's author is the sealer.
 */
export function openDrop(wrap: NostrEvent, dropPrivateKey: Uint8Array, recipientPrivateKey: Uint8Array): Opened {
  if (wrap.kind !== GIFT_WRAP_KIND) throw new Error('not a gift wrap')
  const wrapKey = nip44.getConversationKey(dropPrivateKey, wrap.pubkey)
  const seal = JSON.parse(nip44.decrypt(wrap.content, wrapKey)) as NostrEvent
  if (seal.kind !== 13) throw new Error('not a seal')
  if (!verifyEvent(seal)) throw new Error('bad seal signature')
  const sealKey = nip44.getConversationKey(recipientPrivateKey, seal.pubkey)
  const rumor = JSON.parse(nip44.decrypt(seal.content, sealKey)) as UnsignedEvent & { id: string }
  if (rumor.pubkey !== seal.pubkey) throw new Error('rumor author is not the sealer')
  return { rumor, seal }
}

/** Strip the padding tag before showing a rumor to anyone. */
export function stripPadding<T extends { tags: string[][] }>(rumor: T): T {
  return { ...rumor, tags: rumor.tags.filter((t) => t[0] !== PAD_TAG) }
}
