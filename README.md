# nostr-deaddrop

**Gift wraps nobody can trace, sent whether or not you have anything to say.**

A NIP-59 gift wrap already hides the sender, pads the content and randomises the timestamp. One thing still gives the game away: the `p` tag names the recipient. This library replaces it.

- **Rendezvous key.** Two people derive a fresh keypair per hour per direction from their shared secret. The wrap's `p` tag is that key. It is a valid key, so every relay stores the wrap, and neither identity appears on the event. Next hour, a different key; the reply comes on another, so no tag ever sees two senders.
- **Cadence.** One wrap per interval whether or not anyone said anything, at a random phase per client so quiet clients do not all post on the same second. An empty slot is a filler wrap nobody can open. Real and filler are the same size and carry the same tags, which by default means no expiration, exactly like every other NIP-17 wrap.
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

## Which key to use

Pass a **rendezvous key**, not your identity key. A rendezvous key is a
child of your root (nsec-tree purpose `rendezvous`) whose public half you
hand to contacts on a card and whose private half your devices hold. Your
identity secret stays in its signer and never computes a shared secret with
anyone; losing a device rotates the rendezvous key and touches nothing
else. Every `myPrivateKey` and `peerPublicKey` below means that key.

## Derivation

Input key material is byte-identical to [forgesworn-link's rendezvous tags](https://github.com/forgesworn/forgesworn-link/blob/main/docs/RENDEZVOUS.md): `case_byte || static_x || eph_x`, where `static_x` is the x-coordinate of ECDH over the two static Nostr keys and `eph_x` mixes per-card ephemerals when either side carries one. A pair that already has Link cards derives drop keys from the material it already holds.

```
scalar = HKDF-SHA256(ikm, salt = "nostr-deaddrop/v1", info = "drop" || 0x00 || u64be(epoch_index) || sender_pubkey, L = 32) mod n
drop   = x-only(scalar · G)
epoch_index = floor(unix_seconds / 3600)
```

`sender_pubkey` is the x-only key of whoever sends on the key: the sender's rendezvous key for a pair, the member's key for a room.

Both ends derive the same key with no ordering rule. A receiver keeps the previous, current and next epoch, so clock skew never drops a pair. Known-answer vectors are in `vectors/deaddrop.json`, using the same test keys as Link's so the `ikm` can be checked across both.

## Rooms

A room whose members share a key does not need pairwise secrets. Everyone
derives every member's drop key per epoch from the room key, under its own
case byte so it can never collide with a pair's. Keys are per member so a
relay never sees several senders on one tag, which would give away the
room's size:

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
const quiet = new QuietTransport(relayPool, { roomKey, member: me, members: roster, kinds: [1460], intervalSeconds: 3600 })
// hand `quiet` to the room session exactly where the relay pool went
quiet.rekey(nextRoomKey)   // whenever the room rotates its key
quiet.setMembers(roster)   // whenever the roster changes
```

Events queue and are wrapped when their slot comes, to the key current
then, so a burst never stacks several wraps on one hour's tag.

Pass the room's **current epoch key**, and call `rekey` when it rotates. A
member removed at a rekey still holds the old key and can open that epoch's
drops, and nothing after; deriving drops from a key that never rotates
would let them read forever. The pending queue is bounded at 256 drops and
`publish` throws when it is full, which means the relay has not taken a
slot in a long time and the person should be told.

## What the relays actually do

Measured 2026-09-09 over one day, unauthenticated REQ for kind 1059:

| Relay | Wraps served | Note |
|---|---|---|
| nos.lol | about 15,500 | broadcast, paged at 500 |
| relay.primal.net | over 20,000 | broadcast, paged at 500 |
| relay.damus.io | 0 | serves no wraps to an unauthenticated pull |
| nostr.wine | 0 | requires auth |
| relay.nostr.band | 0 | serves no wraps |

So a day's broadcast pull from one good relay is roughly 15,000 to 20,000
wraps at about 1.2 KB each, 20 to 25 MB, which a box does without
noticing and a phone on wifi can afford. Two of five large relays refuse
the broadcast pull altogether; a client measures rather than assumes, and
a circle's own boxes always serve it.

## What a relay learns

A wrap signed by a throwaway key, addressed to a key it has never seen, with a fixed-size ciphertext and an expiration a week out. A pull of every gift wrap since a timestamp. Nothing links two wraps to each other or to any person.

Where a relay serves kind 1059 only to the tagged key after NIP-42, `taggedFilter` asks by tag. Both ends hold the drop private key and can authenticate as it. That leaks the tag to that relay and nothing else, and callers should record that the weaker pull was used.

## What the layers around it must do

This library is one layer. It makes the *event* say nothing. The layers
around it make the *connection*, the *keys* and the *bytes* say nothing,
and a client that skips one of them has a hole. Each is a client's job and
each has a known answer:

- **The address.** Post and pull over an anonymous carrier: Tor, I2P, or a
  relay your own circle runs. The library never sees a socket; the carrier
  is where the address is hidden.
- **The rendezvous key.** Derive it as a child of the root, hand only that
  to devices, rotate it by index when a device is lost, and use fresh
  per-card ephemerals so old tags cannot be recomputed from a later theft.
  Then a stolen key costs one index of one pair's pattern, and nothing
  older or newer.
- **The bucket.** One size per conversation, chosen once, never changed.
  The defaults (512 bytes for a pair, 768 for a room) come from a day of
  real wraps on two public relays: median content 556 characters, 90th
  percentile 2140. A pair drop at the default is 1796 characters, a room
  drop 1116. A bigger bucket stands out; do not raise it without a reason.
- **The relay.** Use relays that serve the gift-wrap stream by broadcast:
  your circle's boxes always do. Treat a relay that only serves wraps to
  their tagged key as a weaker path and show it as one.
- **Files and calls.** Bytes go to a content-addressed store over the same
  carrier with the key in a wrap; calls are never quiet, and the client
  says so.

What is left when every layer is in place is one sentence: a watcher who
sees every wire can tell you are one of the people who use a carrier, and
cannot tell whether you spoke, to whom, or when.

## Security notes

- The drop private key is a delivery capability: whoever holds it can open the wrap layer and see a seal they cannot open. Only the real recipient opens the seal.
- Padding is a `pad` tag inside the rumor. Strip it before showing a message. Content larger than the bucket throws; pick a bigger bucket for the whole conversation, not per message.
- Filler wraps are real gift wraps to random keys. They expire like everything else and cost a relay a few kilobytes an hour per sender.

## Licence

MIT. ForgeSworn.
