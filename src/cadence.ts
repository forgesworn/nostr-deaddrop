import type { NostrEvent } from 'nostr-tools/pure'
import { randomBytes } from '@noble/hashes/utils.js'
import { createFiller, wrapSeal, type DropOptions } from './wrap.js'

export interface CadenceOptions extends DropOptions {
  /** Seconds between slots. Every slot emits exactly one wrap. */
  intervalSeconds: number
  /** Seconds this client's slots are offset from the wall-clock boundary.
   *  Random per client by default, so quiet clients do not all post on the
   *  same second. Fixed in tests. */
  phaseSeconds?: number
}

interface Pending {
  seal: NostrEvent
  /** Called when the slot comes, so the tag is the key current then. */
  dropPublicKey: () => string
}

/** A CSPRNG offset inside one interval. */
export function randomPhase(intervalSeconds: number): number {
  const b = randomBytes(4)
  const r = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0
  return Math.floor((r / 0x100000000) * intervalSeconds)
}

/**
 * One wrap per slot, whether or not anyone said anything. Real drops queue as
 * seals and are wrapped when their slot comes, so the wrap's key, created_at
 * and expiration are the slot's, the same as a filler's; an empty slot emits
 * a filler. The caller owns the timer and the network: call `due(now)` and
 * post whatever comes back.
 */
export class Cadence {
  /** Bounded so a dead relay cannot grow memory without limit. */
  static readonly MAX_PENDING = 256
  private readonly queue: Pending[] = []
  private lastSlot = -1
  readonly phaseSeconds: number

  constructor(private readonly opts: CadenceOptions) {
    if (!(opts.intervalSeconds > 0)) throw new Error('intervalSeconds must be positive')
    this.phaseSeconds = opts.phaseSeconds ?? randomPhase(opts.intervalSeconds)
  }

  /**
   * Queue a seal (from `createDropSeal`). It leaves at the next free slot,
   * wrapped to whatever `dropPublicKey()` returns then: pass
   * `() => watch.sendKey(peer, now()).publicKey` so a burst that waits
   * across an epoch still lands on keys the receiver is watching.
   */
  enqueue(seal: NostrEvent, dropPublicKey: () => string): void {
    if (this.queue.length >= Cadence.MAX_PENDING) throw new Error('cadence queue is full; nothing has been posted in a long time')
    this.queue.push({ seal, dropPublicKey })
  }

  get pending(): number {
    return this.queue.length
  }

  slotIndex(unixSeconds: number): number {
    return Math.floor((unixSeconds - this.phaseSeconds) / this.opts.intervalSeconds)
  }

  /** Unix time of the next slot boundary after `unixSeconds`. */
  nextSlotAt(unixSeconds: number): number {
    return (this.slotIndex(unixSeconds) + 1) * this.opts.intervalSeconds + this.phaseSeconds
  }

  /**
   * Returns the one wrap to post for the current slot, or null if this slot
   * has already been served. Never returns two wraps for one slot and never
   * skips a slot's wrap. If the real drop's key cannot be derived (the epoch
   * is exhausted), the slot gets a filler and the drop waits.
   */
  due(unixSeconds: number): NostrEvent | null {
    const slot = this.slotIndex(unixSeconds)
    if (slot === this.lastSlot) return null
    this.lastSlot = slot
    const opts: DropOptions = { bucket: this.opts.bucket, ttlSeconds: this.opts.ttlSeconds, now: () => unixSeconds }
    const real = this.queue[0]
    if (real) {
      let key: string | undefined
      try { key = real.dropPublicKey() } catch { key = undefined }
      if (key) {
        this.queue.shift()
        return wrapSeal(real.seal, key, opts)
      }
    }
    return createFiller(opts)
  }
}
