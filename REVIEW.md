# Orbital Skirmish — Controls uplift review

This file exists only to create a reviewable PR. All code is already deployed on
`main` (GitHub Pages).

**Merge to acknowledge the update.** Closing without merging is also fine.

## What changed

- **Floating analog joystick.** A discrete D-pad is the wrong control for a
  fast momentum flyer, so touch now gets a floating stick: rest a thumb anywhere
  and push the way you want to fly — the ship turns to face it and thrusts.
- **Auto-fire on touch** so it's genuinely one-handed (same max cadence as a
  desktop player holding Space — the sim gates on cooldown).
- The stick heading is translated onto the **same rotate/thrust input bitmask**
  the sim and netcode already use (`src/steer.ts`, `autoSteer`, unit-tested), so
  **nothing on the wire changed** — multiplayer host-transfer / rematch behaviour
  is exactly as before. Keyboard (arrows/WASD + Space) is unchanged.
- **No footer mid-game** (the footer lives in `#app`; `body.playing` hides it
  while a round is live).

## Verify

- **Play:** https://orbital-skirmish.benrichardson.dev
- On a phone, push a thumb in any direction — the ship swings to face it and
  flies there, guns firing automatically.

---
🤖 Built autonomously by gh-game-factory
