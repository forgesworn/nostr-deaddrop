import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { createRumor, createSeal } from 'nostr-tools/nip59'
import * as nip44 from 'nostr-tools/nip44'
import type { NostrEvent, UnsignedEvent } from 'nostr-tools/pure'
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'

export const GIFT_WRAP_KIND = 1059
export const PAD_TAG = 'pad'
/**
 * Default rumor size in bytes of serialised JSON. Every rumor is padded to
 * exactly this. Chosen from a day of real gift wraps on two public relays
 * (2026-09-09): the median wrap content was 556 characters and the 90th
 * percentile 2140. A 512-byte rumor makes a 1796-character wrap, inside
 * that band; the old default of 2048 made a 4868-character wrap, which
 * stood out from every real one.
 */
export const DEFAULT_BUCKET = 512
/** Default bucket for room drops, which have one layer fewer: a 768-byte plaintext makes a 1116-character wrap. */
export const DEFAULT_ROOM_BUCKET = 768
/**
 * Default time-to-live: none. Ordinary NIP-17 clients do not set an
 * `expiration` tag, so a quiet wrap that carried one would stand out from
 * the crowd it hides in. Set `ttlSeconds` only on a relay you run yourself.
 */
export const DEFAULT_TTL_SECONDS: number | undefined = undefined
/** NIP-59 randomises a wrap's created_at up to this far into the past. Every pull must reach this far behind the time it wants. */
export const CREATED_AT_JITTER = 2 * 24 * 3600

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
  return now - Math.floor((r / 0x100000000) * CREATED_AT_JITTER)
}

/**
 * Pad an unsigned event so that, once it becomes a rumor (id and pubkey filled),
 * its JSON serialisation is exactly `bucket` bytes. Padding is a `pad` tag of
 * JSON-safe characters, which receivers ignore. `created_at` must be set,
 * because its width is part of the size.
 */
export function padToBucket(event: Partial<UnsignedEvent>, bucket = DEFAULT_BUCKET): Partial<UnsignedEvent> {
  if (!Number.isSafeInteger(event.created_at) || event.created_at! < 0) throw new Error('created_at is required to pad: its width is part of the size')
  const tags = (event.tags ?? []).filter((t) => t[0] !== PAD_TAG)
  const probe = {
    id: '0'.repeat(64),
    pubkey: '0'.repeat(64),
    created_at: event.created_at,
    kind: event.kind ?? 14,
    tags: [...tags, [PAD_TAG, '']],
    content: event.content ?? '',
  }
  const base = utf8ToBytes(JSON.stringify(probe)).length
  if (base > bucket) throw new RumorTooLarge(base, bucket)
  return { ...event, tags: [...tags, [PAD_TAG, randomAlnum(bucket - base)]] }
}

/**
 * The inner two layers of a drop: the rumor padded to the bucket and sealed
 * by the sender to the real recipient. A seal is what a sender queues; the
 * wrap is made when the slot comes, so its key and dates are the slot's.
 */
export function createDropSeal(event: Partial<UnsignedEvent>, senderPrivateKey: Uint8Array, recipientPublicKey: string, opts: DropOptions = {}): NostrEvent {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const padded = padToBucket({ created_at: now(), kind: 14, ...event }, opts.bucket ?? DEFAULT_BUCKET)
  const rumor = createRumor(padded, senderPrivateKey)
  return createSeal(rumor, senderPrivateKey, recipientPublicKey)
}

/** The outer layer: a seal wrapped by a throwaway key to the drop key, dated now with NIP-59 jitter. */
export function wrapSeal(seal: NostrEvent, dropPublicKey: string, opts: DropOptions = {}): NostrEvent {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  return wrapToDrop(seal, dropPublicKey, now(), opts.ttlSeconds ?? DEFAULT_TTL_SECONDS)
}

/**
 * Build a drop in one go: rumor padded to the bucket, sealed by the sender to
 * the real recipient, wrapped to the pair's drop key. The wrap's `p` tag is
 * the drop key, so no relay sees either identity. For a cadence, build the
 * seal now with `createDropSeal` and let the cadence wrap it at its slot.
 */
export function createDrop(
  event: Partial<UnsignedEvent>,
  senderPrivateKey: Uint8Array,
  recipientPublicKey: string,
  dropPublicKey: string,
  opts: DropOptions = {},
): NostrEvent {
  return wrapSeal(createDropSeal(event, senderPrivateKey, recipientPublicKey, opts), dropPublicKey, opts)
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

/** True when the event has the fields a wrap must have. Relays send anything. */
export function looksLikeWrap(e: unknown): e is NostrEvent {
  if (!e || typeof e !== 'object') return false
  const w = e as Record<string, unknown>
  return w.kind === GIFT_WRAP_KIND && typeof w.content === 'string' && typeof w.pubkey === 'string' && /^[0-9a-f]{64}$/.test(w.pubkey)
    && Array.isArray(w.tags) && w.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))
}

/**
 * Open a drop with the pair's drop private key and the recipient's own key.
 * Verifies the seal signature and that the rumor's author is the sealer.
 */
export function openDrop(wrap: NostrEvent, dropPrivateKey: Uint8Array, recipientPrivateKey: Uint8Array): Opened {
  if (!looksLikeWrap(wrap)) throw new Error('not a gift wrap')
  const wrapKey = nip44.getConversationKey(dropPrivateKey, wrap.pubkey)
  const seal = JSON.parse(nip44.decrypt(wrap.content, wrapKey)) as NostrEvent
  if (!seal || typeof seal !== 'object' || seal.kind !== 13 || typeof seal.content !== 'string') throw new Error('not a seal')
  if (!verifyEvent(seal)) throw new Error('bad seal signature')
  const sealKey = nip44.getConversationKey(recipientPrivateKey, seal.pubkey)
  const rumor = JSON.parse(nip44.decrypt(seal.content, sealKey)) as UnsignedEvent & { id: string }
  if (!rumor || typeof rumor !== 'object' || rumor.pubkey !== seal.pubkey) throw new Error('rumor author is not the sealer')
  if (typeof rumor.id !== 'string' || !Array.isArray(rumor.tags)) throw new Error('malformed rumor')
  return { rumor, seal }
}

/** Strip the padding tag before showing a rumor to anyone. */
export function stripPadding<T extends { tags: string[][] }>(rumor: T): T {
  return { ...rumor, tags: rumor.tags.filter((t) => t[0] !== PAD_TAG) }
}
