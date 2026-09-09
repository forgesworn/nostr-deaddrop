import type { NostrEvent } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { getPublicKey } from 'nostr-tools/pure'
import { randomBytes } from '@noble/hashes/utils.js'
import {
  DEFAULT_EPOCH_SECONDS, DEFAULT_LOOKBACK_SECONDS, MAX_PER_EPOCH_PAIR,
  deriveDropKeyFromIkm, epochIndexAt, pairIkmCases,
  type DropKey, type PairMaterial, type EphemeralCase,
} from './derive.js'
import { CREATED_AT_JITTER, GIFT_WRAP_KIND, looksLikeWrap } from './wrap.js'

/** One sender's key material as a receiver watches it. */
export interface KeySource {
  /** The ikm this sender's keys derive from, and its case. */
  ikm: Uint8Array
  case: EphemeralCase
  /** The x-only pubkey the sender puts in the derivation. */
  sender: string
  /** How many keys per epoch this sender may use. */
  max: number
  /** Other ikms the sender might be on while cards change hands. Watched for the current epochs only. */
  alternates?: { ikm: Uint8Array; case: EphemeralCase }[]
}

export interface Hit<R = unknown> {
  ref: R
  key: DropKey
  /** True when the match came from an alternate case, which means the peer's card material is out of step with ours. */
  alternate: boolean
}

export class EpochExhausted extends Error {
  constructor(public readonly epochIndex: number, public readonly max: number) {
    super(`all ${max} drop keys for epoch ${epochIndex} are used; the next epoch has fresh ones`)
  }
}

/**
 * The lookup table behind broadcast receive: every drop key every watched
 * sender may use from `lookbackEpochs` ago to one epoch ahead, keyed by
 * tag. Rebuilt incrementally as the clock moves: one new epoch derived,
 * one old one evicted. Alternate cases are derived for the previous,
 * current and next epoch only, where a card transition can be happening.
 */
export class KeyTable<R = unknown> {
  private readonly sources = new Map<string, { source: KeySource; ref: R; derived: Set<number> }>()
  private table = new Map<string, Hit<R> & { id: string }>()
  private currentEpoch = -1
  private readonly used = new Map<string, { epoch: number; counters: Set<number> }>()

  constructor(readonly epochSeconds = DEFAULT_EPOCH_SECONDS, readonly lookbackEpochs = Math.ceil(DEFAULT_LOOKBACK_SECONDS / DEFAULT_EPOCH_SECONDS)) {
    if (!(epochSeconds > 0) || !Number.isInteger(lookbackEpochs) || lookbackEpochs < 1) throw new Error('bad epoch or lookback')
  }

  set(id: string, source: KeySource, ref: R): void {
    this.remove(id)
    this.sources.set(id, { source, ref, derived: new Set() })
    if (this.currentEpoch >= 0) this.deriveMissing(this.currentEpoch)
  }

  remove(id: string): void {
    if (!this.sources.delete(id)) return
    for (const [tag, hit] of this.table) if (hit.id === id) this.table.delete(tag)
    this.used.delete(id)
  }

  get size(): number {
    return this.table.size
  }

  /** Bring the table up to `unixSeconds`. Cheap when the epoch has not moved. */
  refresh(unixSeconds: number): void {
    const e = epochIndexAt(unixSeconds, this.epochSeconds)
    if (e === this.currentEpoch) return
    this.currentEpoch = e
    // Evict: primary keys older than the lookback, alternate keys outside the current three.
    for (const [tag, hit] of this.table) {
      const old = hit.alternate ? hit.key.epochIndex < e - 1 || hit.key.epochIndex > e + 1 : hit.key.epochIndex < e - this.lookbackEpochs
      if (old) this.table.delete(tag)
    }
    for (const s of this.sources.values()) for (const i of [...s.derived]) if (i < e - this.lookbackEpochs) s.derived.delete(i)
    this.deriveMissing(e)
  }

  private deriveMissing(e: number): void {
    for (const [id, s] of this.sources) {
      for (let i = Math.max(0, e - this.lookbackEpochs); i <= e + 1; i++) {
        if (s.derived.has(i)) continue
        s.derived.add(i)
        for (let k = 0; k < s.source.max; k++) {
          const key = deriveDropKeyFromIkm(s.source.ikm, s.source.case, i, s.source.sender, k)
          this.table.set(key.publicKey, { ref: s.ref, key, alternate: false, id })
        }
      }
      // Alternates only for the current three epochs; re-derived each epoch, which is cheap.
      for (const alt of s.source.alternates ?? []) {
        for (const i of [e - 1, e, e + 1]) {
          if (i < 0) continue
          for (let k = 0; k < s.source.max; k++) {
            const key = deriveDropKeyFromIkm(alt.ikm, alt.case, i, s.source.sender, k)
            if (!this.table.has(key.publicKey)) this.table.set(key.publicKey, { ref: s.ref, key, alternate: true, id })
          }
        }
      }
    }
  }

  lookup(tag: string): Hit<R> | undefined {
    return this.table.get(tag)
  }

  tags(): string[] {
    return [...this.table.keys()]
  }

  /**
   * A key to send on now for source `id`, using `ikm` and `sender` as the
   * sender side derives them: a random counter never used in this epoch by
   * this process. Throws EpochExhausted when all are used; the caller waits
   * for the next epoch. A restart forgets which counters were used, so a
   * restarted client may reuse one; that costs one repeated tag, not a key.
   */
  sendKey(id: string, ikm: Uint8Array, c: EphemeralCase, sender: string, max: number, unixSeconds: number): DropKey {
    const e = epochIndexAt(unixSeconds, this.epochSeconds)
    let u = this.used.get(id)
    if (!u || u.epoch !== e) { u = { epoch: e, counters: new Set() }; this.used.set(id, u) }
    if (u.counters.size >= max) throw new EpochExhausted(e, max)
    // Unbiased: reject bytes above the largest multiple of max.
    const limit = 256 - (256 % max)
    let counter: number
    do { const b = randomBytes(1)[0]!; if (b >= limit) continue; counter = b % max } while (counter! === undefined || u.counters.has(counter))
    u.counters.add(counter)
    return deriveDropKeyFromIkm(ikm, c, e, sender, counter)
  }
}

export interface Peer extends Omit<PairMaterial, 'myPrivateKey'> {
  /** Anything the caller wants back on a match (a contact id, a room id). */
  ref?: unknown
}

export interface Match {
  peer: Peer
  key: DropKey
  /** The peer sent on a case other than the one our material says: their card or ours is out of step. */
  alternate: boolean
}

export interface DropWatchOptions {
  epochSeconds?: number
  /** How many epochs back to derive keys for. Wraps older than this are not matched. */
  lookbackEpochs?: number
  /** How many delivered rumor ids to remember for `remember`. */
  rememberSeen?: number
}

/**
 * Knows every drop key the holder currently shares with every peer, from
 * the lookback to one epoch ahead, and matches incoming wraps by their `p`
 * tag. Matching is a set lookup: no cryptography per event.
 *
 * Receive by broadcast: subscribe to all kind 1059 since your last pull
 * (`broadcastFilter` reaches two days further back for the created_at
 * jitter) and feed every event through `match`. Open the matches and
 * then call `remember` with the rumor id to drop replays. Relays see a
 * mirror syncing.
 */
export class DropWatch {
  private readonly peers = new Map<string, { peer: Peer; ikm: Uint8Array; case: EphemeralCase }>()
  private readonly table: KeyTable<Peer>
  private readonly seen = new Set<string>()
  private readonly seenOrder: string[] = []
  private readonly myPublicKey: string
  private readonly rememberSeen: number

  /** `myPrivateKey` is the holder's rendezvous key (a child of the root), never the identity key. */
  constructor(private readonly myPrivateKey: Uint8Array, opts: DropWatchOptions = {}) {
    this.myPublicKey = getPublicKey(myPrivateKey)
    const epochSeconds = opts.epochSeconds ?? DEFAULT_EPOCH_SECONDS
    this.table = new KeyTable<Peer>(epochSeconds, opts.lookbackEpochs ?? Math.ceil(DEFAULT_LOOKBACK_SECONDS / epochSeconds))
    this.rememberSeen = opts.rememberSeen ?? 4096
  }

  addPeer(peer: Peer): void {
    if (typeof peer.peerPublicKey !== 'string' || !/^[0-9a-f]{64}$/.test(peer.peerPublicKey)) throw new Error('peer public key must be lower-case 64-hex')
    const cases = pairIkmCases({ myPrivateKey: this.myPrivateKey, ...peer })
    const [primary, ...alternates] = cases
    this.peers.set(peer.peerPublicKey, { peer, ikm: primary!.ikm, case: primary!.case })
    // Incoming drops are on the keys the PEER sends on.
    this.table.set(peer.peerPublicKey, { ikm: primary!.ikm, case: primary!.case, sender: peer.peerPublicKey, max: MAX_PER_EPOCH_PAIR, alternates }, peer)
  }

  removePeer(peerPublicKey: string): void {
    this.peers.delete(peerPublicKey)
    this.table.remove(peerPublicKey)
  }

  /** Rebuild the lookup table if the epoch moved. Cheap; call before a batch. */
  refresh(unixSeconds: number): void {
    this.table.refresh(unixSeconds)
  }

  /** The drop key to send to a peer right now: this holder's own direction, a counter unused this epoch. */
  sendKey(peerPublicKey: string, unixSeconds: number): DropKey {
    const p = this.peers.get(peerPublicKey)
    if (!p) throw new Error('unknown peer')
    return this.table.sendKey(peerPublicKey, p.ikm, p.case, this.myPublicKey, MAX_PER_EPOCH_PAIR, unixSeconds)
  }

  /** Every `p` tag this watch would accept right now. */
  tags(unixSeconds: number): string[] {
    this.refresh(unixSeconds)
    return this.table.tags()
  }

  /** How many keys the table holds; a measure of the derivation cost paid so far. */
  get size(): number {
    return this.table.size
  }

  /**
   * Match by tag. Does not remember anything: a relay or a stranger who
   * has seen a tag could otherwise burn it with junk. Open the wrap, and
   * if it opens, call `remember(rumor.id)`.
   */
  match(event: NostrEvent, unixSeconds: number): Match | null {
    if (!looksLikeWrap(event)) return null
    this.refresh(unixSeconds)
    for (const t of event.tags) {
      if (t[0] !== 'p' || typeof t[1] !== 'string') continue
      const hit = this.table.lookup(t[1])
      if (hit) return { peer: hit.ref, key: hit.key, alternate: hit.alternate }
    }
    return null
  }

  /**
   * Record a delivered rumor id. Returns false if it was already delivered,
   * which happens when a relay replays or when someone re-wraps an old seal
   * to a current tag. Apps must not show a rumor twice.
   */
  remember(rumorId: string): boolean {
    if (this.seen.has(rumorId)) return false
    this.seen.add(rumorId)
    this.seenOrder.push(rumorId)
    if (this.seenOrder.length > this.rememberSeen) this.seen.delete(this.seenOrder.shift()!)
    return true
  }
}

/**
 * The broadcast pull: every gift wrap since the last pull, for anyone.
 * Reaches two days further back than asked, because a wrap's created_at
 * is randomised that far into the past; without that a pull an hour after
 * the last one sees only the wraps whose jitter happened to be under an
 * hour, about two per cent of them.
 */
export function broadcastFilter(since: number, limit?: number): Filter {
  const f: Filter = { kinds: [GIFT_WRAP_KIND], since: Math.max(0, since - CREATED_AT_JITTER) }
  if (limit) f.limit = limit
  return f
}

/**
 * The weaker pull, for relays that serve wraps only to the tagged key after
 * NIP-42: ask by tag. What that relay learns is more than the tag: how many
 * tags one connection asks for is the peer count, and consecutive epochs'
 * tags on one connection chain into one identity. Use `taggedFilters` and
 * issue each over its own circuit if this path is used at all, and record
 * that it was.
 */
export function taggedFilter(tags: string[], since: number): Filter {
  return { kinds: [GIFT_WRAP_KIND], '#p': tags, since: Math.max(0, since - CREATED_AT_JITTER) }
}

/** One filter per tag, for one request per tag over separate circuits. */
export function taggedFilters(tags: string[], since: number): Filter[] {
  return tags.map((t) => taggedFilter([t], since))
}
