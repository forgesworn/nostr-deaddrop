# Changelog

## 0.1.0

- Review: keys are per direction and per room member, no expiration by default, wraps built at send time, random slot phase per client, replay dedupe, CSPRNG timestamp jitter.

- Room drops: one drop key per epoch from a shared room key, `createRoomDrop`, `openRoomDrop`, `createRoomFiller`.
- `QuietTransport`: wraps any publish/subscribe/close transport so chosen kinds ride drops on a cadence and return by broadcast.

- Rendezvous drop keys per epoch, ikm byte-identical to forgesworn-link.
- Padded NIP-59 drops, filler drops, uniform expiration.
- DropWatch broadcast matching, Cadence one-wrap-per-slot.
- Known-answer vectors.
