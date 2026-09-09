import type { NostrEvent } from 'nostr-tools/pure'
import { createFiller, type DropOptions } from './wrap.js'

export interface CadenceOptions extends DropOptions {
  /** Seconds between slots. Every slot emits exactly one wrap. */
  intervalSeconds: number
}

/**
 * One wrap per slot, whether or not anyone said anything. Real drops queue and
 * go out one per slot in order; an empty slot emits a filler. The caller owns
 * the timer and the network: call `due(now)` and post whatever comes back.
 */
export class Cadence {
  private readonly queue: NostrEvent[] = []
  private lastSlot = -1

  constructor(private readonly opts: CadenceOptions) {
    if (!(opts.intervalSeconds > 0)) throw new Error('intervalSeconds must be positive')
  }

  /** Queue a real drop. It leaves at the next free slot. */
  enqueue(wrap: NostrEvent): void {
    this.queue.push(wrap)
  }

  get pending(): number {
    return this.queue.length
  }

  slotIndex(unixSeconds: number): number {
    return Math.floor(unixSeconds / this.opts.intervalSeconds)
  }

  /** Unix time of the next slot boundary after `unixSeconds`. */
  nextSlotAt(unixSeconds: number): number {
    return (this.slotIndex(unixSeconds) + 1) * this.opts.intervalSeconds
  }

  /**
   * Returns the one wrap to post for the current slot, or null if this slot
   * has already been served. Never returns two wraps for one slot and never
   * skips a slot's wrap.
   */
  due(unixSeconds: number): NostrEvent | null {
    const slot = this.slotIndex(unixSeconds)
    if (slot === this.lastSlot) return null
    this.lastSlot = slot
    const real = this.queue.shift()
    return real ?? createFiller({ ...this.opts, now: () => unixSeconds })
  }
}
