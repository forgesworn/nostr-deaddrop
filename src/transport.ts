import { matchFilters } from 'nostr-tools/filter'
import type { Filter } from 'nostr-tools/filter'
import type { NostrEvent } from 'nostr-tools/pure'
import { getPublicKey, generateSecretKey } from 'nostr-tools/pure'
import { DEFAULT_EPOCH_SECONDS, DEFAULT_LOOKBACK_SECONDS, MAX_PER_EPOCH_ROOM, type DropKey } from './derive.js'
import { roomIkm, createRoomDrop, createRoomFiller, openRoomDrop } from './room.js'
import { randomOffset } from './cadence.js'
import { CREATED_AT_JITTER, GIFT_WRAP_KIND, looksLikeWrap, type DropOptions } from './wrap.js'
import { EpochExhausted, KeyTable, type UsedCounters } from './watch.js'

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
  /** Most pages the backfill will walk before giving up on a relay that never runs dry. */
  maxPages?: number
  /** Override the timer (tests). Returns a stop function. */
  schedule?: (tick: () => void, everyMs: number) => () => void
  /**
   * Where inside each slot this client posts, in seconds from the slot's
   * start. Drawn fresh per slot by default, so posting times carry no fixed
   * phase a relay could link across circuits. Tests pass `() => 0`.
   */
  slotOffset?: (slot: number) => number
  /**
   * The part of each epoch's counter space this device draws from, `[lo, hi)`
   * inside `[0, 16)`. Two devices posting as one member must use disjoint
   * ranges, or they will use one tag twice in an hour.
   */
  counterRange?: [number, number]
  /** Called when a slot's publish fails (the drop stays queued and the same wrap is retried) or a queued event cannot be wrapped (it is dropped). */
  onError?: (error: unknown) => void
  /**
   * Called once the relay has taken a slot's wrap: with the inner event it
   * carried, or none for a filler. This is the moment a counter is spent
   * and a queued message has left the device, so it is where a caller
   * persists `exportUsed` and settles whatever was waiting on the send.
   */
  onPosted?: (posted: { slot: number; wrap: NostrEvent; inner?: NostrEvent }) => void
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
 * it has never seen, at a fresh random moment inside each slot, and a pull
 * of every 1059 since the lookback.
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
  private readonly maxPages: number
  private readonly now: () => number
  private readonly stopTimer: () => void
  private closed = false
  private lastSlot = -1
  private offsetSlot = -1
  private offset = 0
  private readonly slotOffset: (slot: number) => number
  private members: string[]
  private readonly member: string
  private readonly fillerKind: number
  private readonly range: [number, number]
  private readonly queue: NostrEvent[] = []
  /** The wrap built for the slot in hand, kept until the relay takes it, so a retry re-posts the same event and burns no counter. */
  private current?: { slot: number; wrap: NostrEvent; inner?: NostrEvent }
  private inFlight = false
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
    this.maxPages = opts.maxPages ?? 1000
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.slotOffset = opts.slotOffset ?? (() => randomOffset(opts.intervalSeconds))
    this.range = opts.counterRange ?? [0, MAX_PER_EPOCH_ROOM]
    this.table = new KeyTable<string>(this.epochSeconds, Math.ceil(this.lookbackSeconds / this.epochSeconds))
    for (const m of this.members) this.table.set(m, this.sourceFor(m), m)
    this.stopTimer = opts.schedule
      ? opts.schedule(() => { this.tick().catch((e) => opts.onError?.(e)) }, 1000)
      : this.scheduleDeadline()
  }

  /** Wake at the chosen slot deadline. A fixed polling phase can fall
   * before every random offset and skip whole slots, including fillers.
   * Recheck the clock at least every 30 seconds and retry a refused publish
   * after one second, without overlapping writes or catching up old slots. */
  private scheduleDeadline(): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (first = false): void => {
      if (this.closed) return
      const now = this.now()
      const slot = this.slotIndex(now)
      const at = slot <= this.lastSlot
        ? (slot + 1) * this.opts.intervalSeconds
        : slot * this.opts.intervalSeconds + this.offsetFor(slot)
      const delay = at > now ? Math.min(30_000, (at - now) * 1000) : first ? 1 : 1000
      timer = setTimeout(() => {
        this.tick().catch((e) => this.opts.onError?.(e)).finally(() => arm())
      }, delay)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    }
    arm(true)
    return () => { if (timer !== undefined) clearTimeout(timer) }
  }

  private sourceFor(m: string) {
    return { ikm: this.ikm, case: 'room' as const, sender: m, max: MAX_PER_EPOCH_ROOM }
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
    for (const m of this.members) this.table.set(m, this.sourceFor(m), m)
  }

  /** The roster changed. Only the difference is touched, so this member's used counters survive. */
  setMembers(members: string[]): void {
    const next = [...new Set(members.concat(this.member))]
    for (const m of this.members) if (!next.includes(m)) this.table.remove(m)
    for (const m of next) if (!this.table.has(m)) this.table.set(m, this.sourceFor(m), m)
    this.members = next
  }

  describe(): { url: string; read: boolean; write: boolean }[] {
    return this.inner.describe?.() ?? []
  }

  /** The drop key a send now would use: this member's own, this epoch, a counter unused so far. Throws when the epoch is exhausted. */
  sendKey(): DropKey {
    return this.table.sendKey(this.member, this.ikm, 'room', this.member, MAX_PER_EPOCH_ROOM, this.now(), this.range)
  }

  /** The counters used this epoch, to persist so a restart does not draw one twice. */
  exportUsed(): Record<string, UsedCounters> {
    return this.table.exportUsed()
  }

  /** Restore what `exportUsed` gave before a restart. */
  importUsed(state: Record<string, UsedCounters>): void {
    this.table.importUsed(state, () => this.ikm, this.now())
  }

  private slotIndex(unixSeconds: number): number {
    return Math.floor(unixSeconds / this.opts.intervalSeconds)
  }

  private offsetFor(slot: number): number {
    if (slot !== this.offsetSlot) {
      this.offsetSlot = slot
      const o = this.slotOffset(slot)
      this.offset = Number.isFinite(o) ? Math.min(Math.max(0, Math.floor(o)), this.opts.intervalSeconds - 1) : 0
    }
    return this.offset
  }

  /**
   * Post whatever the current slot owes, once its moment inside the slot
   * has come: the oldest queued drop or a filler. The wrap is built once
   * per slot and kept; the drop leaves the queue and the slot counts as
   * served only once the relay has taken it. A rejected publish reports
   * through `onError` and the same wrap is posted again next tick, so a
   * relay outage delays, never discards, and burns no counter. Two ticks
   * never overlap. If this epoch's keys are used up, the slot gets a
   * filler and the drop waits for the next epoch; a drop that cannot be
   * wrapped for any other reason is discarded and reported.
   */
  async tick(): Promise<void> {
    if (this.closed || this.inFlight) return
    const now = this.now()
    const slot = this.slotIndex(now)
    if (slot <= this.lastSlot) return
    if (now < slot * this.opts.intervalSeconds + this.offsetFor(slot)) return
    this.inFlight = true
    try {
      if (!this.current || this.current.slot !== slot) this.current = this.buildForSlot(slot)
      try {
        await this.inner.publish(this.current.wrap)
      } catch (e) {
        this.opts.onError?.(e)
        return
      }
      this.lastSlot = slot
      const posted = this.current
      if (posted.inner) this.queue.shift()
      this.current = undefined
      try { this.opts.onPosted?.(posted) } catch (e) { this.opts.onError?.(e) }
    } finally {
      this.inFlight = false
    }
  }

  private buildForSlot(slot: number): { slot: number; wrap: NostrEvent; inner?: NostrEvent } {
    const dropOpts: DropOptions = { bucket: this.opts.bucket, ttlSeconds: this.opts.ttlSeconds, now: this.now }
    while (this.queue.length > 0) {
      const inner = this.queue[0]!
      let key: DropKey
      try {
        key = this.sendKey()
      } catch (e) {
        if (e instanceof EpochExhausted) break
        throw e
      }
      try {
        return { slot, wrap: createRoomDrop(inner, key.publicKey, dropOpts), inner }
      } catch (e) {
        // The key is burnt, the message cannot be carried: drop it, say so, try the next.
        this.queue.shift()
        this.opts.onError?.(e)
      }
    }
    return { slot, wrap: createRoomFiller(this.fillerKind, dropOpts) }
  }

  /**
   * Queue an event of a quiet kind for the next free slot. An event too
   * large for the bucket is refused here, to the caller, rather than
   * discovered at its slot; the check wraps it to a throwaway key.
   */
  async publish(event: NostrEvent): Promise<void> {
    if (!this.kinds.has(event.kind)) return this.inner.publish(event)
    if (this.queue.length >= QuietTransport.MAX_PENDING) throw new Error('quiet queue is full; the relay has not taken a slot in a long time')
    createRoomDrop(event, getPublicKey(generateSecretKey()), { bucket: this.opts.bucket, now: this.now })
    this.queue.push(event)
    // The queue drains on the cadence, one per slot, wrapped when its slot
    // comes. A caller cannot make the stream burst by sending fast.
  }

  get pending(): number {
    return this.queue.length
  }

  /**
   * Take a queued event back before its slot: the caller's room moved to
   * a key the event was not written for, or the person withdrew it.
   * Returns whether it was still queued. A wrap already built for it and
   * awaiting a retry is discarded with it; the counter that wrap drew
   * stays marked, which costs this epoch one key and nothing else.
   */
  drop(id: string): boolean {
    const i = this.queue.findIndex((e) => e.id === id)
    if (i < 0) return false
    this.queue.splice(i, 1)
    if (this.current?.inner?.id === id) this.current = undefined
    return true
  }

  /** Match a wrap, open it, and deliver the inner event to every quiet subscription whose filters it matches. */
  private receive(wrap: NostrEvent, via?: string): void {
    if (!looksLikeWrap(wrap)) return
    // A wrap already opened costs a lookup, not another decryption, when a relay replays it.
    if (this.delivered.has('w:' + wrap.id)) return
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
    // Remembered only once it opened, by the wrap id and the inner id: a
    // stranger who saw a tag cannot burn it with junk, and a re-wrapped old
    // event is not shown twice.
    this.keep('w:' + wrap.id)
    // A drop on this member's own key that opened was posted by a device
    // holding the room key as this one: its counter is spent for this
    // device too. Two devices on one member that can see each other's
    // drops then repeat a tag only inside the relay's propagation delay.
    if (hit.ref === this.member) this.table.markUsed(this.member, this.ikm, hit.key.epochIndex, hit.key.counter, this.now())
    if (this.delivered.has('i:' + inner.id)) return
    this.keep('i:' + inner.id)
    for (const s of this.quietSubs) if (matchFilters(s.filters, inner)) s.onEvent(inner, via)
  }

  private keep(key: string): void {
    if (this.delivered.has(key)) return
    this.delivered.add(key)
    this.deliveredOrder.push(key)
    if (this.deliveredOrder.length > 8192) this.delivered.delete(this.deliveredOrder.shift()!)
  }

  /**
   * One broadcast pull per transport, however many subscriptions ride on
   * it: a live subscription from now, plus a paged backfill over the
   * lookback, both reaching two days further back for the created_at
   * jitter. Pages walk `until` backwards, inclusive at the boundary second
   * so nothing stamped in that second is skipped, and stop when a page
   * brings nothing new, reaches the lookback, or the page cap is hit; the
   * next page is scheduled on a fresh stack, so a relay that answers
   * synchronously cannot overflow it.
   */
  private ensureBroadcast(): void {
    if (this.broadcastStop) return
    const now = this.now()
    const since = Math.max(0, now - this.lookbackSeconds - CREATED_AT_JITTER)
    const stops = new Set<() => void>()
    this.broadcastStop = () => { for (const s of stops) s() }
    stops.add(this.inner.subscribe([{ kinds: [GIFT_WRAP_KIND], since: Math.max(0, now - CREATED_AT_JITTER) }], (w, via) => this.receive(w, via)))
    let pages = 0
    let boundaryIds = new Set<string>()
    const page = (until: number) => {
      if (this.closed) return
      if (pages >= this.maxPages) { this.finishBackfill(); return }
      pages += 1
      let fresh = 0
      let oldest = Infinity
      const idsAtOldest = new Set<string>()
      let stop: (() => void) | undefined
      let ended = false
      const onEnd = () => {
        ended = true
        if (stop) { stops.delete(stop); stop() }
        const more = fresh > 0 && oldest > since && Number.isFinite(oldest)
        if (!more) { this.finishBackfill(); return }
        boundaryIds = idsAtOldest
        // A fresh stack for the next page: a synchronous relay would otherwise recurse.
        Promise.resolve().then(() => page(oldest)).catch((e) => this.opts.onError?.(e))
      }
      stop = this.inner.subscribe([{ kinds: [GIFT_WRAP_KIND], since, until, limit: this.pageSize }], (w, via) => {
        if (!w || typeof w.id !== 'string' || boundaryIds.has(w.id)) return
        fresh += 1
        if (typeof w.created_at === 'number') {
          if (w.created_at < oldest) { oldest = w.created_at; idsAtOldest.clear() }
          if (w.created_at === oldest) idsAtOldest.add(w.id)
        }
        this.receive(w, via)
      }, onEnd)
      if (ended) stop()
      else stops.add(stop)
    }
    page(now)
  }

  private finishBackfill(): void {
    this.backfillDone = true
    for (const s of this.quietSubs) { const e = s.onEose; s.onEose = undefined; e?.() }
  }

  subscribe(filters: Filter[], onEvent: (event: NostrEvent, via?: string) => void, onEose?: () => void): () => void {
    // A filter that mixes quiet and plain kinds is split, so neither side is lost.
    const quietFilters: Filter[] = []
    const plainFilters: Filter[] = []
    for (const f of filters) {
      if (!f.kinds) { plainFilters.push(f); continue }
      const q = f.kinds.filter((k) => this.kinds.has(k))
      const p = f.kinds.filter((k) => !this.kinds.has(k))
      if (q.length) quietFilters.push({ ...f, kinds: q })
      if (p.length) plainFilters.push({ ...f, kinds: p })
    }
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
