import type { NostrEvent } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
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
  /** How many keys per epoch this sender may use, 1 to 65536. */
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

/** The counters one sender has used in one epoch, for persisting across a restart. */
export interface UsedCounters { epoch: number; counters: number[] }

interface Source<R> {
  source: KeySource
  ref: R
  ikmHex: string
  /** Epochs whose primary keys are in the table. */
  derived: Set<number>
  /** Epochs whose alternate keys are in the table. */
  altDerived: Set<number>
  /** Every tag this source owns, for eviction without a table scan. */
  tags: Set<string>
}

/**
 * The lookup table behind broadcast receive: every drop key every watched
 * sender may use from `lookbackEpochs` ago to one epoch ahead, keyed by
 * tag. Rebuilt incrementally as the clock moves: one new epoch derived,
 * one old one evicted. Alternate cases are derived for the previous,
 * current and next epoch only, where a card transition can be happening.
 *
 * The table also tracks which counters this process has used to send, per
 * source and epoch, so no tag is drawn twice. That state survives a roster
 * change that leaves the sender's material unchanged, and can be exported
 * for persistence across a restart; two processes drawing from one space
 * must partition it with `range`.
 */
export class KeyTable<R = unknown> {
  private readonly sources = new Map<string, Source<R>>()
  private table = new Map<string, Hit<R> & { id: string }>()
  private currentEpoch = -1
  private readonly used = new Map<string, { ikmHex: string; epoch: number; counters: Set<number> }>()

  constructor(readonly epochSeconds = DEFAULT_EPOCH_SECONDS, readonly lookbackEpochs = Math.ceil(DEFAULT_LOOKBACK_SECONDS / DEFAULT_EPOCH_SECONDS)) {
    if (!(epochSeconds > 0) || !Number.isInteger(lookbackEpochs) || lookbackEpochs < 1) throw new Error('bad epoch or lookback')
  }

  /** Watch a source. Re-setting an id with the same ikm keeps its used counters; a new ikm forgets them, since the keys are new. */
  set(id: string, source: KeySource, ref: R): void {
    if (!Number.isInteger(source.max) || source.max < 1 || source.max > 65536) throw new Error('max must be an integer from 1 to 65536')
    const ikmHex = bytesToHex(source.ikm)
    const prevUsed = this.used.get(id)
    this.remove(id)
    if (prevUsed && prevUsed.ikmHex === ikmHex) this.used.set(id, prevUsed)
    this.sources.set(id, { source, ref, ikmHex, derived: new Set(), altDerived: new Set(), tags: new Set() })
    if (this.currentEpoch >= 0) this.deriveMissing(this.currentEpoch)
  }

  has(id: string): boolean {
    return this.sources.has(id)
  }

  remove(id: string): void {
    const s = this.sources.get(id)
    if (!s) return
    for (const tag of s.tags) this.table.delete(tag)
    this.sources.delete(id)
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
    for (const s of this.sources.values()) {
      for (const tag of s.tags) {
        const hit = this.table.get(tag)
        if (!hit) { s.tags.delete(tag); continue }
        const old = hit.alternate ? hit.key.epochIndex < e - 1 || hit.key.epochIndex > e + 1 : hit.key.epochIndex < e - this.lookbackEpochs
        if (old) { this.table.delete(tag); s.tags.delete(tag) }
      }
      for (const i of [...s.derived]) if (i < e - this.lookbackEpochs) s.derived.delete(i)
      for (const i of [...s.altDerived]) if (i < e - 1 || i > e + 1) s.altDerived.delete(i)
    }
    this.deriveMissing(e)
  }

  private put(s: Source<R>, id: string, key: DropKey, alternate: boolean): void {
    if (this.table.has(key.publicKey)) return
    this.table.set(key.publicKey, { ref: s.ref, key, alternate, id })
    s.tags.add(key.publicKey)
  }

  private deriveMissing(e: number): void {
    for (const [id, s] of this.sources) {
      for (let i = Math.max(0, e - this.lookbackEpochs); i <= e + 1; i++) {
        if (s.derived.has(i)) continue
        s.derived.add(i)
        for (let k = 0; k < s.source.max; k++) this.put(s, id, deriveDropKeyFromIkm(s.source.ikm, s.source.case, i, s.source.sender, k), false)
      }
      if (!s.source.alternates?.length) continue
      for (const i of [e - 1, e, e + 1]) {
        if (i < 0 || s.altDerived.has(i)) continue
        s.altDerived.add(i)
        for (const alt of s.source.alternates) {
          for (let k = 0; k < s.source.max; k++) this.put(s, id, deriveDropKeyFromIkm(alt.ikm, alt.case, i, s.source.sender, k), true)
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
   * sender side derives them: a random counter in `range` (all of `[0, max)`
   * by default) never used in this epoch by this process. Throws
   * EpochExhausted when all are used; the caller waits for the next epoch.
   */
  sendKey(id: string, ikm: Uint8Array, c: EphemeralCase, sender: string, max: number, unixSeconds: number, range: [number, number] = [0, max]): DropKey {
    const e = epochIndexAt(unixSeconds, this.epochSeconds)
    const [lo, hi] = range
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi > max || hi <= lo) throw new Error('counter range must lie inside [0, max)')
    const ikmHex = bytesToHex(ikm)
    let u = this.used.get(id)
    if (!u || u.epoch !== e || u.ikmHex !== ikmHex) { u = { ikmHex, epoch: e, counters: new Set() }; this.used.set(id, u) }
    let free = 0
    for (let k = lo; k < hi; k++) if (!u.counters.has(k)) free += 1
    if (free === 0) throw new EpochExhausted(e, hi - lo)
    // Unbiased 16-bit draw over the range, rejecting the top slice.
    const span = hi - lo
    const limit = 65536 - (65536 % span)
    let counter: number | undefined
    while (counter === undefined || u.counters.has(counter)) {
      const b = randomBytes(2)
      const r = (b[0]! << 8) | b[1]!
      if (r >= limit) continue
      counter = lo + (r % span)
    }
    u.counters.add(counter)
    return deriveDropKeyFromIkm(ikm, c, e, sender, counter)
  }

  /** The counters this process has used, per source, for persisting across a restart. */
  exportUsed(): Record<string, UsedCounters> {
    const out: Record<string, UsedCounters> = {}
    for (const [id, u] of this.used) out[id] = { epoch: u.epoch, counters: [...u.counters] }
    return out
  }

  /** Restore counters exported before a restart. Entries for another epoch or another ikm are ignored. */
  importUsed(state: Record<string, UsedCounters>, ikmOf: (id: string) => Uint8Array | undefined, unixSeconds: number): void {
    const e = epochIndexAt(unixSeconds, this.epochSeconds)
    for (const [id, u] of Object.entries(state ?? {})) {
      const ikm = ikmOf(id)
      if (!ikm || !u || u.epoch !== e || !Array.isArray(u.counters)) continue
      this.used.set(id, { ikmHex: bytesToHex(ikm), epoch: e, counters: new Set(u.counters.filter((k) => Number.isInteger(k) && k >= 0)) })
    }
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
  /** How many delivered rumor ids and opened wrap ids to remember. */
  rememberSeen?: number
  /**
   * The part of each epoch's counter space this device draws from, `[lo, hi)`
   * inside `[0, 64)`. Two devices holding one rendezvous key must draw from
   * disjoint ranges, or they will use one tag twice in an hour.
   */
  counterRange?: [number, number]
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
  private readonly range: [number, number]

  /** `myPrivateKey` is the holder's rendezvous key (a child of the root), never the identity key. */
  constructor(private readonly myPrivateKey: Uint8Array, opts: DropWatchOptions = {}) {
    this.myPublicKey = getPublicKey(myPrivateKey)
    const epochSeconds = opts.epochSeconds ?? DEFAULT_EPOCH_SECONDS
    this.table = new KeyTable<Peer>(epochSeconds, opts.lookbackEpochs ?? Math.ceil(DEFAULT_LOOKBACK_SECONDS / epochSeconds))
    this.rememberSeen = opts.rememberSeen ?? 4096
    this.range = opts.counterRange ?? [0, MAX_PER_EPOCH_PAIR]
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
    return this.table.sendKey(peerPublicKey, p.ikm, p.case, this.myPublicKey, MAX_PER_EPOCH_PAIR, unixSeconds, this.range)
  }

  /** The counters used this epoch, to persist so a restart does not draw one twice. */
  exportUsed(): Record<string, UsedCounters> {
    return this.table.exportUsed()
  }

  /** Restore what `exportUsed` gave before a restart. */
  importUsed(state: Record<string, UsedCounters>, unixSeconds: number): void {
    this.table.importUsed(state, (id) => this.peers.get(id)?.ikm, unixSeconds)
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
   * Match by tag. Does not remember anything about a wrap that has not
   * opened: a relay or a stranger who has seen a tag could otherwise burn it
   * with junk. A wrap whose id was remembered after a successful open is
   * skipped here, so a relay replaying it costs a lookup, not a decryption.
   */
  match(event: NostrEvent, unixSeconds: number): Match | null {
    if (!looksLikeWrap(event)) return null
    if (typeof event.id === 'string' && this.seen.has('w:' + event.id)) return null
    this.refresh(unixSeconds)
    for (const t of event.tags) {
      if (t[0] !== 'p' || typeof t[1] !== 'string') continue
      const hit = this.table.lookup(t[1])
      if (hit) return { peer: hit.ref, key: hit.key, alternate: hit.alternate }
    }
    return null
  }

  /**
   * Record a delivered rumor id, and the wrap it came in, after the wrap
   * opened. Returns false if the rumor was already delivered, which happens
   * when a relay replays or when someone re-wraps an old seal to a current
   * tag. Apps must not show a rumor twice.
   */
  remember(rumorId: string, wrapId?: string): boolean {
    if (typeof wrapId === 'string') this.keep('w:' + wrapId)
    if (this.seen.has('r:' + rumorId)) return false
    this.keep('r:' + rumorId)
    return true
  }

  private keep(key: string): void {
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.seenOrder.push(key)
    if (this.seenOrder.length > this.rememberSeen * 2) this.seen.delete(this.seenOrder.shift()!)
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
