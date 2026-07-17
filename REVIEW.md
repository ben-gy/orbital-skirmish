# Orbital Skirmish — Build Review

This file exists only to create a reviewable PR. All code is already deployed on `main`.

**Merge to acknowledge the build.** Closing without merging is also fine.

## Links
- **Play:** https://orbital-skirmish.benrichardson.dev
- **GitHub Pages:** https://ben-gy.github.io/orbital-skirmish/ *(redirects to the custom domain)*

## Note on this build

This is the game the 2026-07-13 factory run planned but never built — that run
died ~70 seconds in, after copying the engine but before writing a line of
gameplay. It was finished on 2026-07-17 against the current routine (the original
plan predated principles 8–18), with a fresh engine copy, and it was reviewed by
an adversarial multi-agent pass before shipping. That review raised 22 candidate
defects; 5 survived verification and all 5 are fixed and pinned by tests:

- the live-round **Pause** control silently tore the room down on one tap (now a
  labelled leave-confirm, since a P2P round genuinely cannot pause);
- a peer **promoted to host in the lobby** kept a disabled, unwired mode picker;
- **`Ship.respawn` was absent from the wire**, so a promoted host resurrected
  every ship mid-death-penalty;
- the rematch note read **"Waiting for 0 more…"** forever when you were the last
  peer left;
- a **leave-then-rejoin-the-same-code** race walked into net.ts's teardown throw.
