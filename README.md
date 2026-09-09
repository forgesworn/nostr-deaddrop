# nostr-deaddrop

**Gift wraps nobody can trace, sent whether or not you have anything to say.**

A NIP-59 gift wrap already hides the sender, pads the content and randomises the timestamp. One thing still gives the game away: the `p` tag names the recipient. This library replaces it.

- **Rendezvous key.** Two people derive a fresh keypair per hour from their shared secret. The wrap's `p` tag is that key. It is a valid key, so every relay stores the wrap, and neither identity appears on the event. Next hour, a different key.
- **Cadence.** One wrap per interval whether or not anyone said anything. An empty slot is a filler wrap nobody can open. Real and filler are the same size and carry the same expiration.
- **Broadcast receive.** Pull every recent kind 1059 and match tags against a local table. A relay sees a mirror syncing. Matching is a set lookup, no cryptography per event.

Over Tor, a watcher sees a Tor user posting one wrap an hour and a relay mirroring gift wraps, which is what thousands of NIP-17 users and every mirror already look like. It cannot tell whether you said anything, to whom, or when. It can tell you use Tor. Nothing here hides that.

Byte-for-byte NIP-59. No new kinds, no new tags a relay has to know about, nothing a plain relay refuses.

## Use

```ts
import { DropWatch, Cadence, createDrop, openDrop, stripPadding, broadcastFilter } from 'nostr-deaddrop'

// Both sides hold the other's public key from a contact card or a bond.
const watch = new DropWatch(myPrivateKey)
watch.addPeer({ peerPublicKey: friendPub, ref: 'friend' })

// Send: seal to the friend, wrap to this hour's drop key, queue for the next slot.
const key = watch.sendKey(friendPub, now())
const wrap = createDrop({ kind: 14, content: 'see you at eight', tags: [['p', friendPub]] }, myPrivateKey, friendPub, key.publicKey)
const cadence = new Cadence({ intervalSeconds: 3600 })
cadence.enqueue(wrap)
setInterval(() => { const w = cadence.due(now()); if (w) publish(w) }, 30_000)

// Receive: every wrap since last time, from anyone, over your carrier.
for await (const ev of subscribe(broadcastFilter(lastPull))) {
  const m = watch.match(ev, now())
  if (!m) continue
  const { rumor } = openDrop(ev, m.key.privateKey, myPrivateKey)
  show(stripPadding(rumor), m.peer.ref)
}
```

## Derivation

Input key material is byte-identical to [forgesworn-link's rendezvous tags](https://github.com/forgesworn/forgesworn-link/blob/main/docs/RENDEZVOUS.md): `case_byte || static_x || eph_x`, where `static_x` is the x-coordinate of ECDH over the two static Nostr keys and `eph_x` mixes per-card ephemerals when either side carries one. A pair that already has Link cards derives drop keys from the material it already holds.

```
scalar = HKDF-SHA256(ikm, salt = "nostr-deaddrop/v1", info = "drop" || 0x00 || u64be(epoch_index), L = 32) mod n
drop   = x-only(scalar · G)
epoch_index = floor(unix_seconds / 3600)
```

Both ends derive the same key with no ordering rule. A receiver keeps the previous, current and next epoch, so clock skew never drops a pair. Known-answer vectors are in `vectors/deaddrop.json`, using the same test keys as Link's so the `ikm` can be checked across both.

## Rooms

A room whose members share a key does not need pairwise secrets. Everyone
derives the same drop key per epoch from the room key, under its own case
byte so it can never collide with a pair's:

```
ikm  = 0x10 || HKDF-SHA256(roomKey, salt = "nostr-deaddrop/room/v1", info = "ikm", 32) || 32 zero bytes
```

`createRoomDrop` wraps an already-signed room event to that key with no
seal and no re-signing; `openRoomDrop` gives it back verified. The relay
sees no `d` tag, no kind and no author.

`QuietTransport` does the whole thing for a room: wrap any transport with
`publish`, `subscribe` and `close`, name the kinds that should go quiet, and
those kinds ride inside drops on a cadence and come back by broadcast
through the caller's original filters. Other kinds pass straight through,
which is where live signalling belongs, because a slot of delay ends a call.

```ts
const quiet = new QuietTransport(relayPool, { roomKey, kinds: [1460], intervalSeconds: 3600 })
// hand `quiet` to the room session exactly where the relay pool went
```

## What a relay learns

A wrap signed by a throwaway key, addressed to a key it has never seen, with a fixed-size ciphertext and an expiration a week out. A pull of every gift wrap since a timestamp. Nothing links two wraps to each other or to any person.

Where a relay serves kind 1059 only to the tagged key after NIP-42, `taggedFilter` asks by tag. Both ends hold the drop private key and can authenticate as it. That leaks the tag to that relay and nothing else, and callers should record that the weaker pull was used.

## What it does not do

- Hide that you use Tor or another carrier. That is the carrier's job.
- Carry files or calls. A wrap is a few kilobytes. Put a hash and a key in the wrap and the bytes somewhere else.
- Talk to the network. It builds and opens events and tells you when the next one is due. Publishing and subscribing are yours.

## Security notes

- The drop private key is a delivery capability: whoever holds it can open the wrap layer and see a seal they cannot open. Only the real recipient opens the seal.
- Padding is a `pad` tag inside the rumor. Strip it before showing a message. Content larger than the bucket throws; pick a bigger bucket for the whole conversation, not per message.
- Filler wraps are real gift wraps to random keys. They expire like everything else and cost a relay a few kilobytes an hour per sender.

## Licence

MIT. ForgeSworn.
