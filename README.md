# nostr-deaddrop

**Gift wraps nobody can trace, sent whether or not you have anything to say.**

A NIP-59 gift wrap already hides the sender, pads the content and randomises the timestamp. One thing still gives the game away: the `p` tag names the recipient. This library replaces it.

- **Rendezvous keys.** Two people derive a fresh keypair per drop from their shared secret: one per hour, per direction, per message. The wrap's `p` tag is that key. It is a valid key, so every relay stores the wrap, and neither identity appears on the event. A sender draws each key from the hour's unused ones, so a second message in an hour looks exactly like a filler; what that promise rests on is below.
- **Cadence.** One wrap per interval whether or not anyone said anything, each posted at a fresh random moment inside its interval, so a client's posting times carry no phase a relay could link across circuits. An empty slot is a filler wrap nobody can open. Real drops queue as seals and are wrapped when their slot comes, so real and filler have the same size, the same tags, the same created_at spread and, if set, the same expiration, which counts from the jittered created_at and so gives no true post time away.
- **Broadcast receive.** Pull every recent kind 1059, paged, and match tags against a local table that covers the whole lookback. A relay sees a mirror syncing. Matching is a set lookup, no cryptography per event.

Over Tor, a watcher sees a Tor user posting one wrap per interval and a relay mirroring gift wraps. It cannot tell whether you said anything, to whom, or when. It can tell you use Tor, and a client that posts exactly one wrap per interval has a rhythm no human has: this hides *which* quiet client you are, not *that* you are one. Nothing here hides that. What remains, in the profile's own words: a watcher with months and deep inspection can still tell you are in a crowd, and a global passive observer with patience against a small circle is not answered here.

Byte-for-byte NIP-59. No new kinds, no new tags a relay has to know about, nothing a plain relay refuses.

## Use

```ts
import { DropWatch, Cadence, createDropSeal, openDrop, stripPadding, broadcastFilter } from 'nostr-deaddrop'

// Both sides hold the other's public key from a contact card or a bond.
const watch = new DropWatch(myPrivateKey)
watch.addPeer({ peerPublicKey: friendPub, ref: 'friend' })

// Send: seal to the friend now, queue it; the cadence wraps it at its slot to a key unused this hour.
const seal = createDropSeal({ kind: 14, content: 'see you at eight', tags: [['p', friendPub]] }, myPrivateKey, friendPub)
const cadence = new Cadence({ intervalSeconds: 3600 })
cadence.enqueue(seal, () => watch.sendKey(friendPub, now()).publicKey)
setInterval(() => { const w = cadence.due(now()); if (w) publish(w) }, 30_000)

// Receive: every wrap since last time, from anyone, over your carrier. The filter
// reaches two days further back than `lastPull` for the created_at jitter; page it.
for await (const ev of subscribe(broadcastFilter(lastPull))) {
  const m = watch.match(ev, now())
  if (!m) continue
  let opened
  try { opened = openDrop(ev, m.key.privateKey, myPrivateKey) } catch { continue }
  if (!watch.remember(opened.rumor.id)) continue     // a replay, or an old seal re-wrapped
  show(stripPadding(opened.rumor), m.peer.ref)
}
```

The table behind `match` holds every key every peer may use from two days
back to an hour ahead: 64 keys an hour per peer, about a second per peer
to derive on a laptop and roughly 1.3 KB per key in memory, built once and
then one epoch at a time. Pass `lookbackEpochs` to shorten it. A sender
that has used all 64 keys in an hour throws `EpochExhausted`; the cadence
then posts a filler and the drop waits for the next hour.

**What "no tag twice" rests on.** The used counters live in this process.
A restart forgets them, and two devices holding one rendezvous key draw
independently, so either can repeat a tag in the hour it happened, and a
repeated tag is the one thing that marks two wraps as real and related.
Two rules keep the promise: give each device its own `counterRange` (the
phone `[0, 32)`, the laptop `[32, 64)`), and persist `exportUsed()` and
restore it with `importUsed()` across a restart. A client that does
neither has this hour's tags at risk, and nothing older or newer.

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
scalar = HKDF-SHA256(ikm, salt = "nostr-deaddrop/v1",
                     info = "drop" || 0x00 || u64be(epoch_index) || sender_pubkey || u16be(counter), L = 32) mod n
drop   = x-only(scalar · G)
epoch_index = floor(unix_seconds / 3600)
counter     = 0 .. 63 for a pair, 0 .. 15 for a room member; a sender never uses one twice in an epoch
```

`sender_pubkey` is the x-only key of whoever sends on the key: the sender's rendezvous key for a pair, the member's key for a room. The counter is drawn at random from the unused ones, so the order of a sender's drops is not in the tags either.

Both ends derive the same keys with no ordering rule. A receiver keeps every key from the lookback (two days by default) to one epoch ahead, so neither clock skew nor a night asleep drops a pair; while cards are changing hands it also watches the other cases the pair could be in for the current three epochs, and a match says whether it came from one of those. Known-answer vectors are in `vectors/deaddrop.json`, using the same test keys as Link's so the `ikm` can be checked across both; they now include room keys and counters.

## Rooms

A room whose members share a key does not need pairwise secrets. Everyone
derives every member's drop keys per epoch from the room key, under its own
case byte so it can never collide with a pair's. Keys are per member and
per counter (16 an hour each), so no tag is used twice and nothing on the
wire counts the room:

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

Events queue and are wrapped when their slot comes, each to a key unused
this hour, so a burst never stacks several wraps on one tag. A slot's wrap
is built once and kept, and its drop leaves the queue only once the relay
has taken it: a rejected publish reports through `onError` and the same
wrap is posted again next tick, so a relay outage delays, never discards,
and burns no key. Ticks never overlap. An event too big for the bucket is
refused by `publish` itself, to the caller, so it can never sit at the
head of the queue. The pending queue is bounded at 256 drops and `publish`
throws when it is full, which means nothing has been posted in a long
time and the person should be told. A roster change keeps this member's
used counters; a rekey forgets them, since the keys are new. Two devices
posting as one member need disjoint `counterRange`s, `[0, 8)` and
`[8, 16)`, and `exportUsed` and `importUsed` carry counters across a
restart. A drop that opens on this member's own key was posted by another
device holding the same room key, and its counter is marked used here as
well, so two devices on one member that can see each other's drops repeat
a tag only inside the relay's propagation delay; disjoint ranges remain
the guarantee, this is the backstop. `onPosted` fires once the relay has
taken a slot's wrap, with the inner event it carried or none for a filler:
that is the moment a counter is spent and a message has left the device,
so it is where to persist `exportUsed` and to settle whatever was waiting
on the send.

Receiving is one broadcast pull per transport however many subscriptions
ride on it: a live subscription from now plus a paged backfill over the
lookback (two days by default, `pageSize` 500, at most `maxPages` pages),
both reaching two days further back for the created_at jitter. Pages are
inclusive at the boundary second so nothing stamped there is skipped, and
stop when a page brings nothing new. Opened wraps and delivered inner
events are remembered by id, so a replay costs a lookup and a re-wrapped
old event is shown once. A filter that mixes a quiet kind with a plain one
is split and both sides delivered.

Pass the room's **current epoch key**, and call `rekey` when it rotates. A
member removed at a rekey still holds the old key and can open that key's
drops, and nothing after; deriving drops from a key that never rotates
would let them read forever. Anything still queued at a rekey goes out on
the new key: a member removed at the rekey does not receive it.

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
noticing and a phone on wifi can afford. Those relays serve 500 a page,
which is why the transport pages. Two of five large relays refuse the
broadcast pull altogether; a client measures rather than assumes, and a
circle's own boxes always serve it.

## What a relay learns

A wrap signed by a throwaway key, addressed to a key it has never seen and will never see again, with a fixed-size ciphertext and, by default, no expiration. A pull of every gift wrap since a timestamp. Nothing on the events links two wraps to each other or to any person; what the connection leaks is the carrier's business, above.

Where a relay serves kind 1059 only to the tagged key after NIP-42, `taggedFilters` asks by tag, one request per tag. Both ends hold the drop private key and can authenticate as it. That relay learns each tag it is asked for; asked for many on one connection it would learn the peer count and could chain one client's tags across hours into an identity, so send each request over its own circuit, and record that the weaker pull was used.

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

- The drop private key is a delivery capability: whoever holds it can open the wrap layer and see a seal they cannot open. The seal carries the sender's public key and signature, so a stolen drop key attributes that one wrap to its sender with proof; it opens nothing inside, and no other wrap.
- `match` remembers nothing, because a relay that has seen a tag could otherwise burn it with junk carrying the same id. Open the wrap, then `remember(rumor.id)`; anything already remembered is a replay or an old seal re-wrapped by a key holder, and must not be shown twice.
- Padding is a `pad` tag inside the rumor. Strip it before showing a message. Content larger than the bucket throws; pick a bigger bucket for the whole conversation, not per message. `padToBucket` needs `created_at`, because its width is part of the size.
- Filler wraps are real gift wraps to random keys. They cost a relay a few kilobytes an hour per sender.
- `Cadence.due` hands the caller one wrap per slot and forgets it; if the relay refuses it, post that same wrap again rather than asking for another. A slot that passed while the caller slept is skipped, not caught up, so the rate never bursts.
- The rumor's id is checked against its hash on open, so the id an app deduplicates on cannot be chosen by the sender.

## Licence

MIT. ForgeSworn.
