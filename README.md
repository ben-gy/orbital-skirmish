# Orbital Skirmish

**Dogfight in a shared gravity well — thrust, slingshot around the star, and be the last ship flying.**

🎮 Play: https://orbital-skirmish.benrichardson.dev

## What it is

You fly a momentum-based ship in a circular arena with a lethal star at the
centre. The star pulls **everything** — you, your rivals, and every bullet in
flight. So you never aim where someone *is*; you aim where gravity will carry the
shot. The rim bounces, so the well and the wall together turn every fight into an
orbit you are trying to win.

The tension is that the three things you want are the three things that kill you:
speed (momentum you cannot undo), the centre (the short path across the arena runs
straight past the thing that eats you), and aggression (a bullet inherits your
velocity, so charging someone makes your shots brutal and spends the speed you
need to climb back out of the well).

**Solo Survival** is the Play button: escalating waves of AI pilots and asteroids,
five lives, no lobby and no waiting. **Deathmatch** is the same arena with 2–4
humans over a shared room code — last ship flying wins, and the rematch happens
inside the room with a running match tally.

## How to play

**Rotate and thrust — you keep your momentum, so plan the stop before the go.**
Curve your shots around the star, and don't let it eat you. The rocks and the rim
bite too. **Last ship flying wins.** You have five lives.

- **Desktop:** ←/→ or A/D rotate · ↑/W thrust · Space fire · P pause · M mute
- **Mobile:** virtual D-pad on the left, fire button on the right

### Modes

Each one changes the spatial problem, not a difficulty dial:

- **Skirmish** — the open arena. The well is a tool, the rocks are traffic.
- **Nova** — the star flares every nine seconds: the kill radius swells and a
  shockwave throws every ship and bullet outward. The centre becomes a clock you
  have to read.
- **Belt** — a weak star and a crowded field. The well barely matters; cover is
  real and bullets die on rock.

In a room, the **host's** pick is what everyone plays, and it travels frozen
inside the round start so two peers can never disagree about the arena.

## Multiplayer

**Live peer-to-peer, 2–4 players, no server.** One player creates a room and
shares the code (type it in, or use the invite link); your browsers connect
directly to each other over WebRTC. The host runs the authoritative simulation and
broadcasts snapshots at 20Hz; everyone else sends inputs. If the host leaves, a
survivor is promoted and the round keeps running — it can still be won.

A free public signalling relay is used only to introduce the browsers to each
other. No game server, no accounts, and nothing about your game is stored
anywhere.

## Tech

- Vite 6 + vanilla TypeScript
- Canvas 2D rendering
- Shared engine: fixed-timestep loop, unified input, procedural audio, Trystero P2P netcode
- Vitest for logic + P2P-sync determinism + host-transfer + balance simulation
- GitHub Pages hosting

The simulation (`src/game/sim.ts`) is pure, headless and deterministic — no DOM,
no clock, no `Math.random`. That is what lets `tests/balance.test.ts` play a few
thousand bot-vs-bot rounds and assert the game is still a contest: seat win rates
level at every table size, and an early lead worth ~40% against a 25% chance,
rising to ~74% by the endgame.

No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less
page-view counts via Cloudflare Web Analytics.

## Local dev

```bash
npm install
npm run dev
npm test
npm run build
npm run preview
```

Regenerate the home-screen icons from `public/favicon.svg` with
`node scripts/gen-icons.mjs`. Print the balance curves with
`BALANCE_REPORT=1 npx vitest run tests/balance.test.ts`.

## license

[GNU Affero General Public License v3.0 or later](./LICENSE), with an attribution
requirement added under section 7(b) — see
[ADDITIONAL-TERMS.md](./ADDITIONAL-TERMS.md).

In short: you may run, modify, redistribute and even sell this, but if you
distribute it — or run a modified version where other people can reach it — you
have to publish your source under the same licence and keep the attribution. A
separate commercial licence without those obligations is available on request:
<hi@ben.gy>.

Third-party components keep their own licences — see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
