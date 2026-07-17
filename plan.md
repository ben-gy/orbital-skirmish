# Game Plan: Orbital Skirmish

> Rewritten 2026-07-17. The original plan was drafted on 2026-07-13 and the run
> died ~70 seconds in, before a line of gameplay. It predates principles 8–18
> (one-room rematch, sticky host, 3 modes, countdown, mobile hardening, manifest,
> and the mandatory balance sim), and it described net.ts's old min-id election,
> since replaced by incumbency. This file is the plan; the old one is superseded.

## Overview
- **Name:** Orbital Skirmish
- **Repo name:** orbital-skirmish
- **Tagline:** Dogfight in a shared gravity well — thrust, slingshot around the star, and be the last ship flying.
- **Genre (directory category):** arcade

## Core Loop
You fly a momentum-based ship in a circular arena with a lethal star at the
centre. The star pulls **everything** — you, your rivals, and every bullet in
flight. So you never aim where someone *is*; you aim where gravity will carry
the shot. The rim bounces, so the well and the wall together turn every fight
into an orbit you are trying to win.

The tension is that the three things you want are the three things that kill
you: speed (momentum you cannot undo), the centre (the short path across the
arena runs straight past the thing that eats you), and aggression (thrusting at
someone spends the velocity you need to climb back out of the well).

- **Solo (Survival):** escalating waves of AI ships and asteroids. 3 lives,
  respawn with brief invulnerability, score for kills and rocks. Playable in the
  first 5 seconds — no lobby, no waiting.
- **Live P2P (Deathmatch):** 2–4 humans, 3 lives each, last ship flying wins.
  Asteroids are a shared hazard. Rematch happens **inside the room**.

**Win:** last ship with lives remaining (most kills if the round clock expires).
**Lose:** spend all 3 lives on rivals' bullets, the rocks, or the star.

## Controls
- **Desktop:** ←/→ or A/D rotate · ↑/W thrust · Space fire (held, rate-limited) ·
  P pause · M mute.
- **Mobile:** `input.ts` virtual D-pad (left/right rotate, up thrusts) + a `fire`
  action button. Fully thumb-playable at 375px. Note `input.ts` routes
  `up/left/right` into `state.axis` and only non-directional actions (`fire`)
  into `state.down`/`pressed` — the ship reads both.

## Modes (principle 14 — three shapes, genuine spread)

`src/modes.ts`. The **host's** pick travels **frozen inside the round start** via
`createRounds`' `roundOpts()`; guests render `state().hostOpts`, never their own
local pick. Every id off the wire goes through `modeOf()`.

1. **Skirmish** — the baseline. Moderate gravity, a handful of asteroids, 3
   lives. The well is a tool; the rocks are traffic.
2. **Nova** — the star **pulses**. Every ~9s it flares: the kill radius swells
   and a shockwave throws every ship and bullet outward. The centre stops being
   a place you pass through and becomes a clock you have to read. Same ships,
   completely different spatial game.
3. **Belt** — weak star, **dense** asteroid field. The well barely matters; the
   rocks do. A knife-fight in traffic, where cover exists and bullets die on
   rock.

These change how a round *plays*, not a number. (Rejected: "more lives" and
"faster bullets" — both are Skirmish with a dial turned, exactly the "two modes
that feel the same" the brief warns about.)

## Multiplayer
- **Mode:** live P2P (plus instant solo Survival from the menu — never a dead lobby).
- **Players:** 2–4. **Topology:** host-authoritative star.
- **Channels (≤12 bytes):** `in` (client → host: input bitmask + tick), `snap`
  (host → all: rounded-coordinate world snapshot at 20Hz). Plus the engine's own
  `rv`/`rs`/`rq` (rematch) and `__h`/`ping` (net).
- **Host loop:** the host advances the authoritative sim on a **`setInterval`**
  (50ms), *not* rAF alone — a backgrounded host tab must not freeze the round.
  rAF drives rendering/interpolation only.
- **Clients:** send their input bitmask on `in` each tick, render the snapshots
  they receive, interpolating with `loop.ts`'s `alpha`.
- **Room entry:** `createRoomEntry` — **Create a room** *or* **type a code**.
  `?room=` is honoured once per load and cleared via `clearRoomInUrl()` on the
  way out (principle 11). Only the peer that minted the code passes
  `claimHost: true`.
- **Late joiner:** lands in the lobby; if a round is live it spectates the host's
  snapshots until the next round, and is in the frozen roster from that round on.
  Never a frozen board.
- **Host leaves (contract gate #2):** `net.ts` promotes exactly one survivor and
  fires `onHostChange`. `NetGame.onHostChange` flips `Sim` authority on: the
  promoted peer **adopts its last applied snapshot as canonical**, resumes the
  50ms keepalive, and keeps advancing — the round still reaches game-over.
  Proven by `tests/takeover.test.ts` **and** the two-tab smoke test.
- **Determinism:** asteroid spawns, splits and respawn points come from the round
  seed via `rng.ts`. Never `Math.random()` for anything peers must agree on.
- **Solo-complete:** fully playable if nobody ever joins.

### End of round → rematch (MANDATORY)
The room is joined **once** and held until the player goes back to the menu.
"Play again" **never touches the Net** — it is a vote plus a new round number via
`rematch.ts` (`createRounds`), and the host broadcasts the new seed **and the
frozen roster** so every peer indexes players identically.

- **Waiting:** the results screen shows who has voted, who has not, and a
  **visible countdown** (`state().startsInMs`) once quorum is reached.
- **A player declines or closes the tab:** the grace countdown starts on quorum
  and the round begins **without them**; `voters()` drops peers who left. No
  deadlock. The host can always **force start**.
- **The host leaves on the results screen:** the promoted peer runs the rematch
  and inherits no tally — `rematch.ts`'s 1500ms resync poll re-collects votes.
- **Persists across rounds:** a running **match tally** (rounds won per player),
  held in `src/match.ts`, keyed by peer id.
- **Back to lobby** is offered and does **not** leave the room.

## Results screen (principle 9 — everyone's result, every time)
Not a name and a number: a per-player breakdown of **kills, deaths, best streak,
shots fired and accuracy**, for **every** player, on **every** peer — including a
peer who died early (they keep watching, then get the summary) and one whose host
went silent. The round winner is crowned; the match tally sits underneath.
Everyone reaches this screen.

## Juice Plan
- **Sound** (`sound.ts` — the nine real patches, no invented names): `blip`
  countdown pips + menu moves, `select` on confirm, `jump` on thrust ignition
  (rate-limited), `hit` on bullet-hits-ship, `explosion` on ship death and rock
  split, `coin` on kill credit, `powerup` on respawn/invuln, `win`/`lose` on
  round end.
- **Particles:** thruster plume trailing the ship (velocity-inherited), bullet
  impact sparks, ship explosion burst (16 shards), rock-split debris, and a
  star-flare ring in Nova.
- **Screen shake:** small on a hit taken, large on your death, medium on a Nova
  flare. Scaled to 0 under `prefers-reduced-motion`.
- **Hit-stop:** 60ms freeze on a kill.
- **Tweens:** eased scale-in on respawn, score pops, streak counter.
- **Star:** pulsing radial gradient — always the visual centre of gravity.

## Style Direction
**Vibe:** neon / retro-vector — a vector-scope arcade cabinet, lit by a star.
**Palette:** deep navy void `#0a0e1a`, star amber `#ffb03a`. Player colours are
the **Okabe–Ito** colour-blind-safe set: `#56b4e9` (sky), `#e69f00` (orange),
`#009e73` (green), `#cc79a7` (pink). Ships are distinguished by **hull
silhouette** as well as colour — safe under deuteranopia by shape, not hue alone.
**Theme:** dark (arcade/action).
**Reference feel:** the momentum of vector-era asteroids; the legibility of a
good itch.io minigame. Feel only — no IP, no assets, all procedural.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite.
- **Render:** Canvas 2D (continuous motion, many entities, particles).
- **Engine modules copied from patterns/:** net, rematch, lobby, rng, loop,
  input, sound, storage, identity, mobile, noticeboard (+ `mobile.css`).
  Re-copied **fresh** — the Jul 13 scaffold's engine predates sticky-host and
  rematch and must not be reused.
- **Core split:** `src/game/sim.ts` is the **pure, headless, deterministic**
  simulation (no DOM, no rAF, no `Math.random`). That is what makes the balance
  sim and the takeover test possible without a browser or a network.
- **Persistence:** `storage.ts` — mute, best Survival score/wave, player name,
  seen-help, last mode.

## Balance (principle 18 — MANDATORY, and it referees)
`tests/balance.test.ts` runs a few hundred fixed-seed bot-vs-bot deathmatches
headless on `sim.ts` and asserts the **shape** of the outcome:
- **P(leader at t=N eventually wins)**, bucketed through the round — must sit
  near chance early and only spike late.
- **Seat win rate** within a few points of `100/players` at 2P, 3P and 4P.
  Spawns sit on a **rotationally symmetric** ring (seat *i* at angle `2πi/n`) so
  no seat starts nearer the star or the rocks.
- **Blowout rate** and **round length** bounded, to catch a "fix" that just ends
  every round in a draw or never terminates.

**The sim is written BEFORE any tuning, and its baseline is the only thing
allowed to justify a balance change.** Hexbloom's lesson is the method, not the
number: five confident diagnoses were all killed by the sim. No reasoning my way
to a change and shipping it.

## Non-Goals
- No power-ups / weapon pickups (a whole economy; not this run).
- No teams — free-for-all only.
- No async-seed mode (the draw is the live dogfight; a seed-share ghost race is
  an EXPANSION_IDEAS entry, not this run).
- No service worker (principle 17).

## How To Play (player-facing copy)
**Rotate and thrust — you keep your momentum, so plan the stop before the go.**
The star at the centre pulls you, your rivals and every bullet: curve your shots
around it, and don't let it eat you. The rocks and the rim bite too.
**Last ship flying wins.**
