# nostr-deaddrop

Gift wraps nobody can trace, sent whether or not there is anything to say.
It replaces the `p` tag on a NIP-59 gift wrap with a per-epoch rendezvous
key derived from a shared secret, so a watcher cannot tell whether a
message was sent, to whom, or when. Byte-for-byte NIP-59: no new kinds,
no new tags a relay has to know about.

## Build & Test

| Command | Purpose |
|---------|---------|
| `npm ci` | Install dependencies |
| `npm run build` | Compile to `dist` (tsc) |
| `npm test` | Run the vitest suite |
| `npm run typecheck` | Type-check without emitting |
| `npm run vectors` | Regenerate `vectors/deaddrop.json` |

CI runs `typecheck`, `build` and `test` on Node 22 and 24.

## Structure

```
src/
  index.ts      public exports
  derive.ts     epoch and drop key derivation (pair and room)
  wrap.ts       sealing, wrapping, opening, padding
  watch.ts      DropWatch, KeyTable, filters for broadcast/tagged pulls
  cadence.ts    Cadence, one-wrap-per-interval scheduling
  room.ts       room drop keys and room-key wrapping
  transport.ts  QuietTransport, wraps an existing relay transport
test/           vitest suite, includes fuzz and multi-device tests
vectors/        known-answer vectors (deaddrop.json) shared with forgesworn-link
```

## Conventions

- British English in prose and comments.
- No third-party runtime dependencies beyond `@noble/curves`, `@noble/hashes`
  and `nostr-tools`.
- Test files use frozen known-answer vectors in `vectors/deaddrop.json`;
  do not change expected values without regenerating and re-checking against
  forgesworn-link's vectors, which share the same test keys.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | The full public API surface |
| `src/derive.ts` | HKDF-based drop key derivation, epoch windows |
| `README.md` | Protocol walkthrough, security notes, threat model |

## Common Pitfalls

- A rendezvous key is not an identity key: never pass the user's identity
  private key where a function expects `myPrivateKey`/`peerPublicKey` for
  drops; see the README's "Which key to use".
- `match` does not deduplicate; call `remember(rumor.id)` after opening a
  wrap, or a replayed wrap will be shown twice.
- `Cadence.due` releases at most one wrap per slot; a slot missed while
  the caller was offline is skipped, not caught up.
- Two devices sharing one rendezvous or room key must use disjoint
  `counterRange`s and persist `exportUsed`/`importUsed`, or they can repeat
  a tag within an hour.
