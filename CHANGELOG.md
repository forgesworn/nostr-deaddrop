# Changelog

## 0.1.0

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
