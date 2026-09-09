import type { NostrEvent } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { DEFAULT_EPOCH_SECONDS, deriveDropKeyFromIkm, type DropKey, type PairMaterial, pairIkm, epochIndexAt, type EphemeralCase } from './derive.js'
import { GIFT_WRAP_KIND } from './wrap.js'

export interface Peer extends Omit<PairMaterial, 'myPrivateKey'> {
  /** Anything the caller wants back on a match (a contact id, a room id). */
  ref?: unknown
}

export interface Match {
  peer: Peer
  key: DropKey
}

/**
 * Knows every drop key the holder currently shares with every peer, for the
 * previous, current and next epoch, and matches incoming wraps by their `p`
 * tag. Matching is a set lookup: no cryptography per event.
 *
 * Receive by broadcast: subscribe to all kind 1059 since your last pull and
 * feed every event through `match`. Relays see a mirror syncing.
 */
export class DropWatch {
  private readonly peers = new Map<string, { peer: Peer; ikm: Uint8Array; case: EphemeralCase }>()
  private table = new Map<string, Match>()
  private tableEpoch = -1

  constructor(
    private readonly myPrivateKey: Uint8Array,
    private readonly epochSeconds = DEFAULT_EPOCH_SECONDS,
  ) {}

  addPeer(peer: Peer): void {
    const { ikm, case: c } = pairIkm({ myPrivateKey: this.myPrivateKey, ...peer })
    this.peers.set(peer.peerPublicKey, { peer, ikm, case: c })
    this.tableEpoch = -1
  }

  removePeer(peerPublicKey: string): void {
    this.peers.delete(peerPublicKey)
    this.tableEpoch = -1
  }

  /** Rebuild the lookup table if the epoch moved. Cheap; call before a batch. */
  refresh(unixSeconds: number): void {
    const e = epochIndexAt(unixSeconds, this.epochSeconds)
    if (e === this.tableEpoch) return
    const next = new Map<string, Match>()
    for (const { peer, ikm, case: c } of this.peers.values()) {
      for (const i of [e - 1, e, e + 1]) {
        const key = deriveDropKeyFromIkm(ikm, c, i)
        next.set(key.publicKey, { peer, key })
      }
    }
    this.table = next
    this.tableEpoch = e
  }

  /** The drop key to send to a peer right now. */
  sendKey(peerPublicKey: string, unixSeconds: number): DropKey {
    const p = this.peers.get(peerPublicKey)
    if (!p) throw new Error('unknown peer')
    return deriveDropKeyFromIkm(p.ikm, p.case, epochIndexAt(unixSeconds, this.epochSeconds))
  }

  /** Every `p` tag this watch would accept right now. */
  tags(unixSeconds: number): string[] {
    this.refresh(unixSeconds)
    return [...this.table.keys()]
  }

  match(event: NostrEvent, unixSeconds: number): Match | null {
    if (event.kind !== GIFT_WRAP_KIND) return null
    this.refresh(unixSeconds)
    for (const t of event.tags) {
      if (t[0] === 'p' && t[1]) {
        const m = this.table.get(t[1])
        if (m) return m
      }
    }
    return null
  }
}

/** The broadcast pull: every gift wrap since the last pull, for anyone. */
export function broadcastFilter(since: number, limit?: number): Filter {
  const f: Filter = { kinds: [GIFT_WRAP_KIND], since }
  if (limit) f.limit = limit
  return f
}

/**
 * The weaker pull, for relays that serve wraps only to the tagged key after
 * NIP-42: ask by tag. Leaks the tags to that relay and nothing else. Callers
 * SHOULD record that this path was used.
 */
export function taggedFilter(tags: string[], since: number): Filter {
  return { kinds: [GIFT_WRAP_KIND], '#p': tags, since }
}
