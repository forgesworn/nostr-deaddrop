import { afterEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import { QuietTransport } from '../src/index.js'

const NOW = 1_800_000_000
const member = getPublicKey(generateSecretKey())

afterEach(() => vi.useRealTimers())

describe('the default quiet timer', () => {
  it.each([8, 300])('posts in every %i-second slot even when the offset follows the old polling phase', async (intervalSeconds) => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const posts: { at: number; event: NostrEvent }[] = []
    const transport = new QuietTransport({
      async publish(event) { posts.push({ at: Date.now(), event }) },
      subscribe() { return () => {} },
      close() {},
    }, {
      roomKey: new Uint8Array(32).fill(7), member, members: [member],
      kinds: [1460], intervalSeconds, lookbackSeconds: 3600,
      slotOffset: () => intervalSeconds - 1,
    })
    try {
      await transport.publish(finalizeEvent({ kind: 1460, created_at: NOW, tags: [], content: 'queued' }, generateSecretKey()))
      // The real timer must reach the deadline; manually calling tick()
      // cannot expose the polling-phase defect.
      await vi.advanceTimersByTimeAsync((intervalSeconds - 2) * 1000)
      expect(posts).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1000)
      expect(posts).toHaveLength(1)
      expect(transport.pending).toBe(0)
      await vi.advanceTimersByTimeAsync(intervalSeconds * 3000)
      expect(posts.map(p => (p.at / 1000) - NOW)).toEqual(
        [1, 2, 3, 4].map(n => n * intervalSeconds - 1),
      )
      expect(new Set(posts.map(p => p.event.content.length)).size).toBe(1)
    } finally { transport.close() }
    const count = posts.length
    await vi.advanceTimersByTimeAsync(intervalSeconds * 2000)
    expect(posts).toHaveLength(count)
  })

  it('retries a refused wrap without waiting for another slot or making a second wrap', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const attempts: NostrEvent[] = []
    const errors: unknown[] = []
    const transport = new QuietTransport({
      async publish(event) {
        attempts.push(event)
        if (attempts.length === 1) throw new Error('relay unavailable')
      },
      subscribe() { return () => {} }, close() {},
    }, {
      roomKey: new Uint8Array(32).fill(7), member, members: [member],
      kinds: [1460], intervalSeconds: 8, lookbackSeconds: 3600,
      slotOffset: () => 2, onError: e => errors.push(e),
    })
    try {
      await vi.advanceTimersByTimeAsync(2000)
      expect(attempts).toHaveLength(1)
      expect(errors).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(attempts).toHaveLength(2)
      expect(attempts[1]!.id).toBe(attempts[0]!.id)
      await vi.advanceTimersByTimeAsync(6000)
      expect(attempts).toHaveLength(2)
    } finally { transport.close() }
  })
})
