import { matchFilters } from 'nostr-tools/filter'
import type { Filter } from 'nostr-tools/filter'
import type { NostrEvent } from 'nostr-tools/pure'
import { DEFAULT_EPOCH_SECONDS, DEFAULT_LOOKBACK_SECONDS, MAX_PER_EPOCH_ROOM, type DropKey } from './derive.js'
import { roomIkm, createRoomDrop, createRoomFiller, openRoomDrop } from './room.js'
import { randomPhase } from './cadence.js'
import { CREATED_AT_JITTER, GIFT_WRAP_KIND, looksLikeWrap, type DropOptions } from './wrap.js'
import { EpochExhausted, KeyTable } from './watch.js'

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
  /** This member's x-only pubkey as the room knows it. Sends go on its keys. */
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
  /** How far back to pull the broadcast and derive keys, in seconds. Two days by default. */
  lookbackSeconds?: number
  /** Page size for the backfill pull. Public relays serve at most 500 a page. */
  pageSize?: number
  /** Override the timer (tests). Returns a stop function. */
  schedule?: (tick: () => void, everyMs: number) => () => void
  /** Seconds this client's slots are offset from the wall-clock boundary.
   *  Random per client by default, so a relay does not see every quiet client
   *  post on the same second. Fixed in tests. */
  phaseSeconds?: number
  /** Called when a slot's publish fails. The drop stays queued and the slot is retried. */
  onError?: (error: unknown) => void
}

interface QuietSub {
  filters: Filter[]
  onEvent: (event: NostrEvent, via?: string) => void
  onEose?: () => void
}

/**
 * A transport whose chosen kinds ride inside room drops on a cadence and
 * come back by broadcast. Wrap a relay transport with it and a room's chat
 * leaves no stable identifier on any relay: no `d` tag, no kind, no author,
 * no tag used twice, and no gap in the stream when nobody is talking.
 *
 * What a relay sees: one kind 1059 per slot from this client, each to a key
 * it has never seen, and a pull of every 1059 since the lookback.
 */
export class QuietTransport implements Transport {
  readonly quiet = true as const
  /** Real drops waiting for a slot. Bounded so a dead relay cannot grow memory without limit. */
  static readonly MAX_PENDING = 256
  private ikm: Uint8Array
  private readonly table: KeyTable<string>
  private readonly kinds: Set<number>
  private readonly epochSeconds: number
  private readonly lookbackSeconds: number
  private readonly pageSize: number
  private readonly now: () => number
  private readonly stopTimer: () => void
  private closed = false
  private lastSlot = -1
  private members: string[]
  private readonly member: string
  private readonly phase: number
  private readonly fillerKind: number
  private readonly queue: NostrEvent[] = []
  private readonly delivered = new Set<string>()
  private readonly deliveredOrder: string[] = []
  private readonly quietSubs = new Set<QuietSub>()
  private broadcastStop?: () => void
  private backfillDone = false

  constructor(private readonly inner: Transport, private readonly opts: QuietOptions) {
    if (!(opts.intervalSeconds > 0)) throw new Error('intervalSeconds must be positive')
    this.ikm = roomIkm(opts.roomKey)
    this.member = opts.member
    this.members = [...new Set(opts.members.concat(opts.member))]
    this.kinds = new Set(opts.kinds)
    this.fillerKind = opts.kinds[0] ?? GIFT_WRAP_KIND
    this.epochSeconds = opts.epochSeconds ?? DEFAULT_EPOCH_SECONDS
    this.lookbackSeconds = opts.lookbackSeconds ?? DEFAULT_LOOKBACK_SECONDS
    this.pageSize = opts.pageSize ?? 500
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.phase = opts.phaseSeconds ?? randomPhase(opts.intervalSeconds)
    this.table = new KeyTable<string>(this.epochSeconds, Math.ceil(this.lookbackSeconds / this.epochSeconds))
    this.installMembers()
    const schedule = opts.schedule ?? ((tick, everyMs) => { const h = setInterval(tick, everyMs); (h as unknown as { unref?: () => void }).unref?.(); return () => clearInterval(h) })
    this.stopTimer = schedule(() => { this.tick().catch((e) => opts.onError?.(e)) }, Math.max(1000, Math.min(opts.intervalSeconds * 1000, 30_000)))
  }

  private installMembers(): void {
    for (const m of this.members) this.table.set(m, { ikm: this.ikm, case: 'room', sender: m, max: MAX_PER_EPOCH_ROOM }, m)
  }

  /**
   * The room moved to a new key: derive drop keys from it from now on,
   * for sending and for matching. A member removed at the rekey still
   * holds the old key and can open the old key's drops, and nothing
   * after. Anything still queued goes out on the new key: a message not
   * yet posted when the room moved is posted to the room as it is now,
   * and a member removed at the rekey does not receive it.
   */
  rekey(roomKey: Uint8Array): void {
    this.ikm = roomIkm(roomKey)
    for (const m of this.members) this.table.remove(m)
    this.installMembers()
  }

  /** The roster changed. Incoming drops are matched on every member's keys. */
  setMembers(members: string[]): void {
    const next = [...new Set(members.concat(this.member))]
    for (const m of this.members) if (!next.includes(m)) this.table.remove(m)
    this.members = next
    this.installMembers()
  }

  describe(): { url: string; read: boolean; write: boolean }[] {
    return this.inner.describe?.() ?? []
  }

  /** The drop key a send now would use: this member's own, this epoch, a counter unused so far. Throws when the epoch is exhausted. */
  sendKey(): DropKey {
    return this.table.sendKey(this.member, this.ikm, 'room', this.member, MAX_PER_EPOCH_ROOM, this.now())
  }

  private slotIndex(unixSeconds: number): number {
    return Math.floor((unixSeconds - this.phase) / this.opts.intervalSeconds)
  }

  /**
   * Post whatever the current slot owes: the oldest queued drop or a filler.
   * The drop leaves the queue and the slot counts as served only once the
   * relay has taken the wrap; a rejected publish leaves both as they were
   * and reports through `onError`, so a relay outage delays and never
   * discards. If this epoch's keys are used up, the slot gets a filler and
   * the drop waits for the next epoch.
   */
  async tick(): Promise<void> {
    if (this.closed) return
    const slot = this.slotIndex(this.now())
    if (slot === this.lastSlot) return
    const dropOpts: DropOptions = { bucket: this.opts.bucket, ttlSeconds: this.opts.ttlSeconds, now: this.now }
    const inner = this.queue[0]
    let key: DropKey | undefined
    if (inner) {
      try { key = this.sendKey() } catch (e) { if (!(e instanceof EpochExhausted)) throw e }
    }
    const wrap = inner && key ? createRoomDrop(inner, key.publicKey, dropOpts) : createRoomFiller(this.fillerKind, dropOpts)
    try {
      await this.inner.publish(wrap)
    } catch (e) {
      this.opts.onError?.(e)
      return
    }
    this.lastSlot = slot
    if (inner && key) this.queue.shift()
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

  /** Match a wrap, open it, and deliver the inner event to every quiet subscription whose filters it matches. */
  private receive(wrap: NostrEvent, via?: string): void {
    if (!looksLikeWrap(wrap)) return
    this.table.refresh(this.now())
    let hit
    for (const t of wrap.tags) {
      if (t[0] !== 'p' || typeof t[1] !== 'string') continue
      hit = this.table.lookup(t[1])
      if (hit) break
    }
    if (!hit) return
    let inner: NostrEvent
    try { inner = openRoomDrop(wrap, hit.key.privateKey) } catch { return }
    // Remembered only once it opened, and by the inner id: a stranger who
    // saw a tag cannot burn it with junk, and a re-wrapped old seal is not
    // shown twice.
    if (this.delivered.has(inner.id)) return
    this.delivered.add(inner.id)
    this.deliveredOrder.push(inner.id)
    if (this.deliveredOrder.length > 4096) this.delivered.delete(this.deliveredOrder.shift()!)
    for (const s of this.quietSubs) if (matchFilters(s.filters, inner)) s.onEvent(inner, via)
  }

  /**
   * One broadcast pull per transport, however many subscriptions ride on
   * it: a live subscription from now, plus a paged backfill over the
   * lookback, both reaching two days further back for the created_at
   * jitter. Pages walk `until` backwards until a page is empty, stops
   * moving, or reaches the lookback, so a relay that caps pages at 500
   * still yields everything.
   */
  private ensureBroadcast(): void {
    if (this.broadcastStop) return
    const now = this.now()
    const since = Math.max(0, now - this.lookbackSeconds - CREATED_AT_JITTER)
    const stops: (() => void)[] = []
    stops.push(this.inner.subscribe([{ kinds: [GIFT_WRAP_KIND], since: Math.max(0, now - CREATED_AT_JITTER) }], (w, via) => this.receive(w, via)))
    const page = (until: number, lastOldest: number) => {
      if (this.closed) return
      let count = 0
      let oldest = Infinity
      let stop: (() => void) | undefined
      let ended = false
      // Some transports signal EOSE synchronously inside subscribe, before `stop` exists.
      const ended_ = () => {
        ended = true
        stop?.()
        const more = count > 0 && oldest < lastOldest && oldest > since
        if (more) page(oldest - 1, oldest)
        else this.finishBackfill()
      }
      stop = this.inner.subscribe([{ kinds: [GIFT_WRAP_KIND], since, until, limit: this.pageSize }], (w, via) => {
        count += 1
        if (typeof w?.created_at === 'number' && w.created_at < oldest) oldest = w.created_at
        this.receive(w, via)
      }, ended_)
      if (ended) stop()
      else stops.push(stop)
    }
    page(now, Infinity)
    this.broadcastStop = () => { for (const s of stops) s() }
  }

  private finishBackfill(): void {
    this.backfillDone = true
    for (const s of this.quietSubs) { const e = s.onEose; s.onEose = undefined; e?.() }
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
      // The caller's own `since` and the rest of its filter are applied to
      // the inner event once it is open; the wire pull is the broadcast.
      const sub: QuietSub = { filters: quietFilters, onEvent, onEose: eose }
      this.quietSubs.add(sub)
      this.ensureBroadcast()
      if (this.backfillDone) { sub.onEose = undefined; eose() }
      stops.push(() => this.quietSubs.delete(sub))
    }
    if (parts === 0) onEose?.()
    return () => { for (const s of stops) s() }
  }

  close(): void {
    this.closed = true
    this.stopTimer()
    this.broadcastStop?.()
    this.inner.close()
  }
}

/** A filler for this transport's room, exposed for tests and for callers that pace their own stream. */
export function roomFiller(kind: number, opts: DropOptions = {}): NostrEvent {
  return createRoomFiller(kind, opts)
}
