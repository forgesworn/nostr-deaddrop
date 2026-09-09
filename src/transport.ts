import { matchFilters } from 'nostr-tools/filter'
import type { Filter } from 'nostr-tools/filter'
import type { NostrEvent } from 'nostr-tools/pure'
import { DEFAULT_EPOCH_SECONDS, epochIndexAt, deriveDropKeyFromIkm, type DropKey } from './derive.js'
import { roomIkm, createRoomDrop, createRoomFiller, openRoomDrop } from './room.js'
import { Cadence } from './cadence.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { GIFT_WRAP_KIND, type DropOptions } from './wrap.js'
import { broadcastFilter } from './watch.js'

/**
 * The narrowest transport a room needs: publish, subscribe, close. The same
 * shape as KithMoot's `RelayTransport`, so a quiet transport wraps one with
 * no adapter. `via` is the relay that delivered an event, when known.
 */
export interface Transport {
  publish(event: NostrEvent): Promise<void>
  subscribe(filters: Filter[], onEvent: (event: NostrEvent, via?: string) => void, onEose?: () => void): () => void
  close(): void
  describe?(): { url: string; read: boolean; write: boolean }[]
}

export interface QuietOptions extends DropOptions {
  /** The room key everyone in the room holds. Drop keys derive from it. */
  roomKey: Uint8Array
  /** This member's x-only pubkey as the room knows it. Sends go on its key. */
  member: string
  /** Every member's x-only pubkey. Incoming drops are matched on their keys.
   *  Update with `setMembers` as the roster changes. */
  members: string[]
  /** Which event kinds go inside drops. Everything else passes through
   *  untouched. Durable chat belongs here; live signalling does not, because
   *  a slot's worth of delay would end a call. */
  kinds: number[]
  /** Seconds between slots. Every slot posts exactly one drop. */
  intervalSeconds: number
  epochSeconds?: number
  /** How far back to pull the broadcast on subscribe, in seconds. */
  lookbackSeconds?: number
  /** Override the timer (tests). Returns a stop function. */
  schedule?: (tick: () => void, everyMs: number) => () => void
  /** Seconds this client's slots are offset from the wall-clock boundary.
   *  Random per client by default, so a relay does not see every quiet client
   *  post on the same second. Fixed in tests. */
  phaseSeconds?: number
}

/**
 * A transport whose chosen kinds ride inside room drops on a cadence and
 * come back by broadcast. Wrap a relay transport with it and a room's chat
 * leaves no stable identifier on any relay: no `d` tag, no kind, no author,
 * and no gap in the stream when nobody is talking.
 *
 * What a relay sees: one kind 1059 per slot from this client, addressed to a
 * key that changes every epoch, and a pull of every 1059 since the lookback.
 */
export class QuietTransport implements Transport {
  readonly quiet = true as const
  /** Real drops waiting for a slot. Bounded so a dead relay cannot grow memory without limit. */
  static readonly MAX_PENDING = 256
  private ikm: Uint8Array
  private readonly cadence: Cadence
  private readonly kinds: Set<number>
  private readonly epochSeconds: number
  private readonly now: () => number
  private readonly stopTimer: () => void
  private table = new Map<string, DropKey>()
  private tableEpoch = -1
  private closed = false
  private lastSlot = -1
  private roomKey: Uint8Array
  private members: string[]
  private readonly member: string
  private readonly phase: number
  private readonly fillerKind: number
  private readonly queue: NostrEvent[] = []
  private readonly seen = new Set<string>()
  private readonly seenOrder: string[] = []

  constructor(private readonly inner: Transport, private readonly opts: QuietOptions) {
    this.roomKey = opts.roomKey
    this.ikm = roomIkm(opts.roomKey)
    this.member = opts.member
    this.members = [...new Set(opts.members.concat(opts.member))]
    this.kinds = new Set(opts.kinds)
    this.fillerKind = opts.kinds[0] ?? GIFT_WRAP_KIND
    this.epochSeconds = opts.epochSeconds ?? DEFAULT_EPOCH_SECONDS
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.phase = opts.phaseSeconds ?? randomPhase(opts.intervalSeconds)
    this.cadence = new Cadence({ intervalSeconds: opts.intervalSeconds, bucket: opts.bucket, ttlSeconds: opts.ttlSeconds, now: this.now })
    const schedule = opts.schedule ?? ((tick, everyMs) => { const h = setInterval(tick, everyMs); (h as unknown as { unref?: () => void }).unref?.(); return () => clearInterval(h) })
    this.stopTimer = schedule(() => { void this.tick() }, Math.max(1000, Math.min(opts.intervalSeconds * 1000, 30_000)))
  }

  /**
   * The room moved to a new key: derive drop keys from it from now on. A
   * member removed at the rekey still holds the old key and can open the
   * old epoch's drops, and nothing after. Call this wherever the room's
   * own protocol rotates its key; the queue is kept, because a queued drop
   * was wrapped to the key current when it was written and its readers are
   * the members of that epoch.
   */
  rekey(roomKey: Uint8Array): void {
    this.roomKey = roomKey
    this.ikm = roomIkm(roomKey)
    this.tableEpoch = -1
  }

  /** The roster changed. Incoming drops are matched on every member's key. */
  setMembers(members: string[]): void {
    this.members = [...new Set(members.concat(this.member))]
    this.tableEpoch = -1
  }

  describe(): { url: string; read: boolean; write: boolean }[] {
    return this.inner.describe?.() ?? []
  }

  /** The drop key a send now would use: this member's own, this epoch. */
  sendKey(): DropKey {
    return deriveDropKeyFromIkm(this.ikm, 'none', epochIndexAt(this.now(), this.epochSeconds), this.member)
  }

  private refresh(): void {
    const e = epochIndexAt(this.now(), this.epochSeconds)
    if (e === this.tableEpoch) return
    const next = new Map<string, DropKey>()
    for (const m of this.members) {
      for (const i of [e - 1, e, e + 1]) {
        const k = deriveDropKeyFromIkm(this.ikm, 'none', i, m)
        next.set(k.publicKey, k)
      }
    }
    this.table = next
    this.tableEpoch = e
  }

  private slotIndex(unixSeconds: number): number {
    return Math.floor((unixSeconds - this.phase) / this.opts.intervalSeconds)
  }

  /** Post whatever the current slot owes: a queued drop or a filler. */
  async tick(): Promise<void> {
    if (this.closed) return
    const slot = this.slotIndex(this.now())
    if (slot === this.lastSlot) return
    this.lastSlot = slot
    // Wrap at send time, to the key current now, so a burst that queues
    // across hours does not put several wraps on one hour's tag.
    const inner = this.queue.shift()
    const wrap = inner
      ? createRoomDrop(inner, this.sendKey().publicKey, { bucket: this.opts.bucket, ttlSeconds: this.opts.ttlSeconds, now: this.now })
      : createRoomFiller(this.fillerKind, { bucket: this.opts.bucket, ttlSeconds: this.opts.ttlSeconds, now: this.now })
    await this.inner.publish(wrap)
  }

  async publish(event: NostrEvent): Promise<void> {
    if (!this.kinds.has(event.kind)) return this.inner.publish(event)
    if (this.queue.length >= QuietTransport.MAX_PENDING) throw new Error('quiet queue is full; the relay has not taken a slot in a long time')
    this.queue.push(event)
    // The queue drains on the cadence, one per slot, wrapped when its slot
    // comes. A caller cannot make the stream burst by sending fast.
  }

  get pending(): number {
    return this.queue.length
  }

  subscribe(filters: Filter[], onEvent: (event: NostrEvent, via?: string) => void, onEose?: () => void): () => void {
    const quietFilters = filters.filter((f) => f.kinds?.some((k) => this.kinds.has(k)))
    const plainFilters = filters.filter((f) => !f.kinds?.some((k) => this.kinds.has(k)))
    const stops: (() => void)[] = []
    let eoses = 0
    const parts = (quietFilters.length ? 1 : 0) + (plainFilters.length ? 1 : 0)
    const eose = () => { eoses += 1; if (eoses === parts) onEose?.() }
    if (plainFilters.length) stops.push(this.inner.subscribe(plainFilters, onEvent, eose))
    if (quietFilters.length) {
      // A wrap's created_at is randomised up to two days into the past, as
      // NIP-59 recommends, so the broadcast pull reaches two days further
      // back than the caller asked; the caller's own `since` is applied to
      // the inner event once it is open.
      const since = Math.min(...quietFilters.map((f) => f.since ?? this.now() - (this.opts.lookbackSeconds ?? 7 * 24 * 3600))) - 2 * 24 * 3600
      stops.push(this.inner.subscribe([broadcastFilter(since)], (wrap, via) => {
        if (wrap.kind !== GIFT_WRAP_KIND) return
        this.refresh()
        const p = wrap.tags.find((t) => t[0] === 'p')?.[1]
        const key = p ? this.table.get(p) : undefined
        if (!key) return
        if (this.seen.has(wrap.id)) return
        this.seen.add(wrap.id)
        this.seenOrder.push(wrap.id)
        if (this.seenOrder.length > 4096) this.seen.delete(this.seenOrder.shift()!)
        let inner: NostrEvent
        try { inner = openRoomDrop(wrap, key.privateKey) } catch { return }
        if (!matchFilters(quietFilters, inner)) return
        onEvent(inner, via)
      }, eose))
    }
    if (parts === 0) onEose?.()
    return () => { for (const s of stops) s() }
  }

  close(): void {
    this.closed = true
    this.stopTimer()
    this.inner.close()
  }
}

function randomPhase(intervalSeconds: number): number {
  const b = randomBytes(4)
  const r = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0
  return Math.floor((r / 0x100000000) * intervalSeconds)
}

/** A filler for this transport's room, exposed for tests and for callers that pace their own stream. */
export function roomFiller(kind: number, opts: DropOptions = {}): NostrEvent {
  return createRoomFiller(kind, opts)
}
