# Changelog

## 0.3.0 (2026-09-12)

### Features

- reserve quiet room counters



## 0.2.2 (2026-09-10)

### Bug Fixes

- schedule quiet wraps at their slot deadlines (#1)



## 0.2.1 (2026-09-09)

### Bug Fixes

- nostr-tools as a range, so a consumer carries one copy



## 0.2.0 (2026-09-09)

### Features

- drop takes a queued event back before its slot
- a counter seen on the wire is spent for every device on the member, and onPosted marks the moment a drop left
- rekey on QuietTransport, bounded pending queue
- room drops and QuietTransport, so a room's chat rides drops on a cadence with nothing of the room on the wire
- rendezvous drop keys, padded gift wraps, cadence and broadcast watch

### Bug Fixes

- second review pass on cadence, table and transport
- apply the independent review to derivation, cadence, watch and transport
- no Buffer in library source, it must run in a browser; node types for the tests
- bucket defaults from a day of measured wraps, and the relay table
- keys per direction and per member, no expiration by default, wrap at send time, random phase, replay dedupe, CSPRNG jitter



## 0.1.0

- Second review pass (2026-09-09): ticks never overlap and a slot's wrap
  is built once and kept, so a slow or failed publish neither double-posts
  nor burns a key; used counters survive roster changes and can be exported
  and restored across a restart, with per-device `counterRange`s; oversize
  events refused at `publish`; each slot posts at a fresh random offset
  rather than a fixed phase; opened wraps skipped on replay; the pager is
  inclusive at the boundary second, capped, and never recurses on the
  stack; mixed filters split; seals built from the four rumor fields only;
  rumor ids checked against their hash; expiration counted from the
  jittered created_at; `max` above 65536 refused and the counter draw
  widened. README states what "no tag twice" rests on.

- Independent review (2026-09-09), all findings applied: a counter in the
  derivation so no tag is ever used twice (64 an hour per pair sender, 16
  per room member, drawn at random); the pair cadence queues seals and
  wraps at the slot; a rejected publish keeps the drop and the slot; one
  broadcast pull per transport, paged, fanned out to every subscription;
  the receiver's table covers the whole lookback (two days) and watches
  alternate card cases for the current epochs; `broadcastFilter` reaches
  back for the created_at jitter; dedup after opening, keyed on the inner
  id; cadence phase and bound; `padToBucket` requires created_at; epoch
  and counter ranges checked; room keys labelled `room`; README claims
  corrected. Vectors regenerated with counters and room cases.

- Defaults from measurement: pair bucket 512, room bucket 768, so wraps sit inside the size band of real gift wraps.

- Review: keys are per direction and per room member, no expiration by default, wraps built at send time, random slot phase per client, replay dedupe, CSPRNG timestamp jitter.

- Room drops: one drop key per epoch from a shared room key, `createRoomDrop`, `openRoomDrop`, `createRoomFiller`.
- `QuietTransport`: wraps any publish/subscribe/close transport so chosen kinds ride drops on a cadence and return by broadcast.

- Rendezvous drop keys per epoch, ikm byte-identical to forgesworn-link.
- Padded NIP-59 drops, filler drops, uniform expiration.
- DropWatch broadcast matching, Cadence one-wrap-per-slot.
- Known-answer vectors.
