import type { NostrEvent } from 'nostr-tools/pure'
import { randomBytes } from '@noble/hashes/utils.js'
import { createFiller, wrapSeal, type DropOptions } from './wrap.js'
import { EpochExhausted } from './watch.js'

export interface CadenceOptions extends DropOptions {
  /** Seconds between slots. Every slot emits exactly one wrap. */
  intervalSeconds: number
  /**
   * Where inside each slot the wrap goes out, in seconds from the slot's
   * start. Drawn fresh and uniformly per slot by default, so a client's
   * posting times have no fixed phase a relay could link across circuits.
   * Tests pass `() => 0`.
   */
  slotOffset?: (slot: number) => number
  /** Called when a queued seal is discarded because its drop key cannot be made (its peer was removed, say). */
  onError?: (error: unknown) => void
}

interface Pending {
  seal: NostrEvent
  /** Called when the slot comes, so the tag is the key current then. */
  dropPublicKey: () => string
}

/** A CSPRNG offset inside one interval, uniform to the second. */
export function randomOffset(intervalSeconds: number): number {
  const b = randomBytes(4)
  const r = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0
  return Math.floor((r / 0x100000000) * intervalSeconds)
}

/**
 * One wrap per slot, whether or not anyone said anything. Real drops queue as
 * seals and are wrapped when their slot comes, so the wrap's key, created_at
 * and expiration are the slot's, the same as a filler's; an empty slot emits
 * a filler. The caller owns the timer and the network: call `due(now)` and
 * post whatever comes back. Each slot's wrap goes out at a fresh random
 * moment inside the slot, so the rate is fixed and the phase is not.
 */
export class Cadence {
  /** Bounded so a dead relay cannot grow memory without limit. */
  static readonly MAX_PENDING = 256
  private readonly queue: Pending[] = []
  private lastSlot = -1
  private offsetSlot = -1
  private offset = 0
  private readonly slotOffset: (slot: number) => number

  constructor(private readonly opts: CadenceOptions) {
    if (!(opts.intervalSeconds > 0)) throw new Error('intervalSeconds must be positive')
    this.slotOffset = opts.slotOffset ?? (() => randomOffset(opts.intervalSeconds))
  }

  /**
   * Queue a seal (from `createDropSeal`). It leaves at the next free slot,
   * wrapped to whatever `dropPublicKey()` returns then: pass
   * `() => watch.sendKey(peer, now()).publicKey` so a burst that waits
   * across an epoch still lands on keys the receiver is watching. A wrap
   * `due` hands back is the caller's to deliver; if the relay refuses it,
   * post the same wrap again.
   */
  enqueue(seal: NostrEvent, dropPublicKey: () => string): void {
    if (this.queue.length >= Cadence.MAX_PENDING) throw new Error('cadence queue is full; nothing has been posted in a long time')
    this.queue.push({ seal, dropPublicKey })
  }

  get pending(): number {
    return this.queue.length
  }

  slotIndex(unixSeconds: number): number {
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

  /** Unix time at which the current or next slot's wrap is due. */
  nextSlotAt(unixSeconds: number): number {
    const slot = this.slotIndex(unixSeconds)
    const at = slot * this.opts.intervalSeconds + this.offsetFor(slot)
    if (slot > this.lastSlot && unixSeconds < at) return at
    return (slot + 1) * this.opts.intervalSeconds + this.offsetFor(slot + 1)
  }

  /**
   * Returns the one wrap to post for the current slot once its moment has
   * come, or null if it has not or the slot has already been served. Never
   * returns two wraps for one slot. A slot that passed while the caller was
   * asleep is skipped, not caught up, so the rate never bursts. If the real
   * drop's key cannot be derived because the epoch is exhausted, the slot
   * gets a filler and the drop waits; if it cannot be derived for any other
   * reason the drop is discarded, `onError` told, and the slot filled.
   */
  due(unixSeconds: number): NostrEvent | null {
    const slot = this.slotIndex(unixSeconds)
    if (slot <= this.lastSlot) return null
    if (unixSeconds < slot * this.opts.intervalSeconds + this.offsetFor(slot)) return null
    this.lastSlot = slot
    const opts: DropOptions = { bucket: this.opts.bucket, ttlSeconds: this.opts.ttlSeconds, now: () => unixSeconds }
    while (this.queue.length > 0) {
      const real = this.queue[0]!
      let key: string
      try {
        key = real.dropPublicKey()
      } catch (e) {
        if (e instanceof EpochExhausted) break
        this.queue.shift()
        this.opts.onError?.(e)
        continue
      }
      this.queue.shift()
      return wrapSeal(real.seal, key, opts)
    }
    return createFiller(opts)
  }
}
