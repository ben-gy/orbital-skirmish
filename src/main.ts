/**
 * main.ts — bootstrap and screen routing.
 *
 * Owns no game logic. It wires input to a bitmask, routes screens, and holds the
 * ONE Net for the room's whole life. Everything it knows about the world it asks
 * the Sim for.
 *
 * The two rules that shape this file, both learned the expensive way:
 *
 *  - ONE ROOM PER SESSION. The Net is created when you enter a room and torn down
 *    only when you go back to the menu. "Play again" never touches it — it is a
 *    vote and a new round number (engine/rematch.ts). net.ts throws if you break
 *    this; do not route around the throw.
 *  - A ROOM IS A CHOICE. `?room=` is honoured once per page load and cleared on
 *    the way out, so a reload — or reopening from a home-screen icon — never
 *    drags you back into a room you left.
 */

import './styles/mobile.css';
import './styles/main.css';

import { createInput, type Input } from './engine/input';
import { createLoop, type Loop } from './engine/loop';
import { hardenViewport } from './engine/mobile';
import { createNet, type Net, type PeerId } from './engine/net';
import { createRounds, type Rounds } from './engine/rematch';
import { createSfx } from './engine/sound';
import { createStore } from './engine/storage';
import { resolveName } from './engine/identity';
import {
  clearRoomInUrl,
  createLobby,
  createRoomEntry,
  mintCode,
  normalizeRoomCode,
} from './engine/lobby';
import { createCountdown, type Countdown } from './countdown';
import { Fx } from './fx';
import { Match } from './match';
import { DEFAULT_MODE, MODES, modeOf, type ModeId } from './modes';
import { NetGame } from './net-game';
import { computeView, render, seatColor, SEAT_NAMES } from './render';
import { Survival } from './game/survival';
import { IN_FIRE, IN_LEFT, IN_RIGHT, IN_THRUST, Sim, type SimEvent } from './game/sim';
import {
  aboutScreen,
  arenaShell,
  esc,
  FOOTER,
  helpScreen,
  hudRow,
  lobbyModeBlock,
  menuScreen,
  resultsScreen,
  soloOverScreen,
  type ResultsRow,
} from './ui';

const SLUG = 'orbital-skirmish';

const store = createStore(SLUG);
const sfx = createSfx(store.get('muted', false));
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Must run before anything builds an invite link: a lingering ?n= would ride
// along and rename whoever accepts the invite to the host's name.
const playerName = resolveName(store, () => `Pilot ${Math.floor(Math.random() * 900 + 100)}`);

hardenViewport();

const app = document.getElementById('app')!;
app.innerHTML = `<div class="main-content" id="view"></div>${FOOTER}`;
const view = document.getElementById('view')!;

type Screen = 'menu' | 'solo' | 'entry' | 'lobby' | 'round' | 'results';

class Game {
  private screen: Screen = 'menu';
  private mode: ModeId = modeOf(store.get('mode', DEFAULT_MODE)).id;
  private fx = new Fx(reduced);
  private loop: Loop | null = null;
  private input: Input | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private countdown: Countdown | null = null;

  // solo
  private survival: Survival | null = null;

  // multiplayer — ONE net for the room's whole life
  private net: Net | null = null;
  /**
   * The in-flight room teardown, if any. Held so a re-entry can WAIT for it.
   *
   * net.ts marks a room 'leaving' the instant leave() is called and only clears
   * it once Trystero has really let go (~99ms later), and it throws on a join in
   * that window rather than handing back the dying room. That throw is correct
   * and this is the path that walks into it: Menu (leave starts) → Play with
   * friends → type the SAME code → createNet on a room still tearing down.
   * Leaving and rejoining one room is an obvious thing for a player to do.
   */
  private leaving: Promise<void> | null = null;
  private rounds: Rounds | null = null;
  private ng: NetGame | null = null;
  /** The lobby view's handle — destroyed so its own poll cannot outlive it. */
  private lobby: { destroy: () => void } | null = null;
  /** Repaints the mode block while in the lobby. See paintLobbyMode(). */
  private lobbyPoll: ReturnType<typeof setInterval> | null = null;
  private match = new Match();
  private roomCode = '';
  private roster: { id: PeerId; name: string }[] = [];
  private lastAdvance = 0;
  private paused = false;
  private counting = false;
  /** Consumed once — see the "a room is a choice" rule. */
  private deepLink: string | null = null;

  constructor() {
    const p = new URLSearchParams(location.search).get('room');
    if (p) {
      this.deepLink = normalizeRoomCode(p);
      clearRoomInUrl();
    }
    window.addEventListener('beforeunload', () => void this.net?.leave());
    if (this.deepLink) void this.enterRoom(this.deepLink, false);
    else this.showMenu();
    if (!store.get('seenHelp', false)) this.panel(helpScreen(), () => store.set('seenHelp', true));
  }

  // ── shell ──────────────────────────────────────────────────────────────────

  private panel(html: string, onClose?: () => void): void {
    const el = document.createElement('div');
    el.className = 'panel';
    el.innerHTML = `<div class="panel-card">${html}<button class="btn ghost panel-close">Close</button></div>`;
    el.addEventListener('click', (e) => {
      if (e.target === el || (e.target as HTMLElement).classList.contains('panel-close')) {
        el.remove();
        onClose?.();
      }
    });
    app.appendChild(el);
  }

  private wireModes(root: HTMLElement): void {
    root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        this.mode = modeOf(b.dataset.mode).id;
        store.set('mode', this.mode);
        sfx.unlock();
        sfx.play('blip');
        root.querySelectorAll('[data-mode]').forEach((o) => {
          o.classList.toggle('on', o === b);
          o.setAttribute('aria-checked', String(o === b));
        });
        // The host's pick is what the room plays, so a change in the lobby has
        // to be gossiped, not just painted.
        this.rounds?.unvote();
      }),
    );
  }

  showMenu(): void {
    this.teardownRound();
    void this.leaveRoom();
    this.screen = 'menu';
    view.innerHTML = menuScreen(this.mode, store.get('best', { score: 0, wave: 0 }));
    this.wireModes(view);
    view.querySelector('#play')!.addEventListener('click', () => {
      sfx.unlock();
      this.startSolo();
    });
    view.querySelector('#friends')!.addEventListener('click', () => {
      sfx.unlock();
      this.showEntry();
    });
    view.querySelector('#help')!.addEventListener('click', () => this.panel(helpScreen()));
    view.querySelector('#about')!.addEventListener('click', () => this.panel(aboutScreen()));
  }

  // ── the arena shell (shared by solo and multiplayer) ───────────────────────

  /**
   * The arena shell. `live` = a P2P round, which changes what this control IS.
   *
   * You cannot pause a live P2P round: the host keeps simulating whatever this
   * tab does, so "Resume" would hand you back a round you had already lost. The
   * fix is not to make Pause work — it is to stop the button claiming to be
   * something it cannot be. In a room it is a LEAVE control, it says so, and it
   * asks first.
   *
   * It said "Pause" and it silently tore the room down on one tap: a player
   * reaching for A/D and fumbling P — or tapping ❚❚ next to the mute button,
   * which is universally harmless everywhere else — was dumped to the title
   * screen mid-match with no confirmation and no results screen, and their
   * opponent was left alone in the room.
   */
  private buildArena(hud: string, live: boolean): void {
    view.innerHTML = arenaShell(hud, live, sfx.muted());
    this.canvas = document.getElementById('cv') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', this.resize);

    document.getElementById('mute')!.addEventListener('click', (e) => {
      const m = !sfx.muted();
      sfx.setMuted(m);
      store.set('muted', m);
      (e.currentTarget as HTMLElement).textContent = m ? '🔇' : '🔊';
    });
    document.getElementById('pause')!.addEventListener('click', () => this.setPaused(true));
    document.getElementById('resume')!.addEventListener('click', () => this.setPaused(false));
    // Only solo has a Restart — a live round is not this tab's to restart.
    document.getElementById('restart')?.addEventListener('click', () => {
      this.setPaused(false);
      this.startSolo();
    });
    document.getElementById('quit')!.addEventListener('click', () => {
      this.setPaused(false);
      this.showMenu();
    });

    this.input = createInput({
      target: this.canvas,
      keys: {
        ArrowLeft: 'left',
        ArrowRight: 'right',
        ArrowUp: 'up',
        KeyA: 'left',
        KeyD: 'right',
        KeyW: 'up',
        Space: 'fire',
        KeyP: 'pause',
        KeyM: 'mute',
      },
      buttons: [{ action: 'fire', label: '●' }],
    });
  }

  private resize = (): void => {
    const c = this.canvas;
    if (!c) return;
    const r = c.getBoundingClientRect();
    // A scale computed from a 0×0 rect is Infinity and every world coordinate
    // downstream becomes NaN — it does not throw, it silently draws nothing.
    // Ignore the transient measure and let the next frame retry.
    if (r.width < 2 || r.height < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
    this.ctx = c.getContext('2d');
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  /** Is the pause / leave-confirm overlay currently up? */
  private overlayShown(): boolean {
    const o = document.getElementById('pauseo');
    return !!o && !o.hidden;
  }

  private setPaused(p: boolean): void {
    const o = document.getElementById('pauseo');
    if (o) o.hidden = !p;
    // In a live round the overlay is a leave CONFIRMATION and the sim keeps
    // running underneath it — because it is the host's sim, and it would keep
    // running whatever this tab believed. Only solo actually stops.
    this.paused = this.screen === 'round' ? false : p;
  }

  private mask(): number {
    const s = this.input?.state;
    if (!s) return 0;
    let m = 0;
    if (s.axis.x < -0.3) m |= IN_LEFT;
    if (s.axis.x > 0.3) m |= IN_RIGHT;
    if (s.axis.y < -0.3) m |= IN_THRUST;
    if (s.down.has('fire')) m |= IN_FIRE;
    return m;
  }

  private pollHotkeys(): void {
    const s = this.input?.state;
    if (!s) return;
    // Toggle off the OVERLAY, not off `paused` — in a live round `paused` is
    // always false (the sim is the host's), so keying off it made P a one-way
    // trip: every press resolved to "open", and open meant leave.
    if (s.pressed.has('pause')) this.setPaused(!this.overlayShown());
    if (s.pressed.has('mute')) {
      const m = !sfx.muted();
      sfx.setMuted(m);
      store.set('muted', m);
      const b = document.getElementById('mute');
      if (b) b.textContent = m ? '🔇' : '🔊';
    }
  }

  /** Turn sim events into noise and light. Cosmetic only. */
  private playEvents(events: SimEvent[], selfSeat: number): void {
    for (const e of events) {
      switch (e.t) {
        case 'shot':
          sfx.play('blip');
          break;
        case 'hit':
          sfx.play('hit');
          this.fx.burst(e.x, e.y, '#fff', 8, 160, 0.35);
          break;
        case 'boom':
          sfx.play('explosion');
          this.fx.burst(e.x, e.y, seatColor(e.p), 16, 220, 0.7);
          this.fx.shake(e.p === selfSeat ? 26 : 12, 0.3);
          this.fx.hitStop(0.06);
          break;
        case 'star':
          sfx.play('lose');
          this.fx.burst(e.x, e.y, '#ffb03a', 14, 200, 0.6);
          break;
        case 'split':
          sfx.play('hit');
          this.fx.burst(e.x, e.y, '#9fb0cc', 10, 140, 0.5);
          break;
        case 'spawn':
          sfx.play('powerup');
          this.fx.ring(e.x, e.y, seatColor(e.p), 14);
          break;
        case 'flare':
          sfx.play('powerup');
          this.fx.ring(0, 0, '#ffb03a', 36);
          this.fx.shake(18, 0.35);
          break;
      }
    }
  }

  private draw = (): void => {
    const sim = this.survival?.sim ?? this.ng?.sim;
    if (!this.ctx || !this.canvas || !sim) return;
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const lead = this.ng && !this.ng.isHost() ? Math.min((Date.now() - this.lastAdvance) / 1000, 0.12) : 0;
    render(this.ctx, r.width, r.height, {
      sim,
      fx: this.fx,
      view: computeView(r.width, r.height),
      selfSeat: this.survival ? 0 : (this.ng?.selfSeat() ?? -1),
      lead,
      reduced,
    });
  };

  // ── solo ───────────────────────────────────────────────────────────────────

  startSolo(): void {
    this.teardownRound();
    this.screen = 'solo';
    this.fx.clear();
    const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
    this.survival = new Survival(seed, MODES[this.mode]);
    this.buildArena(`<div class="hud-solo"><span id="hs-score">0</span><span id="hs-wave">Wave 1</span><span id="hs-lives"></span></div>`, false);

    this.loop = createLoop({
      update: () => {
        if (this.paused || !this.survival) return;
        this.pollHotkeys();
        // The countdown holds the SIM, not just the player. Letting it run while
        // the overlay counts would mean the wave is already manoeuvring — and
        // shooting — while you are still reading "3", which is the free head
        // start the countdown exists to prevent, handed to the wrong side.
        if (!this.counting && !this.fx.frozen()) {
          this.survival.step(this.mask());
          this.playEvents(this.survival.sim.drainEvents(), 0);
        }
        this.input?.endFrame();
        this.fx.update(1 / 60);
        this.updateSoloHud();
        if (this.survival.sim.over) this.endSolo();
      },
      render: this.draw,
    });
    this.loop.start();
    this.counting = true;
    this.countdown = createCountdown({
      root: view.querySelector('.arena') as HTMLElement,
      sfx,
      reducedMotion: reduced,
      onDone: () => {
        this.counting = false;
        this.countdown = null;
      },
    });
  }

  private updateSoloHud(): void {
    const s = this.survival?.state();
    if (!s) return;
    const set = (id: string, t: string): void => {
      const e = document.getElementById(id);
      if (e && e.textContent !== t) e.textContent = t;
    };
    set('hs-score', s.score.toLocaleString());
    set('hs-wave', `Wave ${s.wave}`);
    set('hs-lives', '♦'.repeat(Math.max(0, s.lives)));
  }

  private endSolo(): void {
    const s = this.survival!.state();
    const best = store.get('best', { score: 0, wave: 0 });
    if (s.score > best.score) store.set('best', { score: s.score, wave: s.wave });
    sfx.play(s.score > best.score ? 'win' : 'lose');
    this.teardownRound();
    this.screen = 'results';
    view.innerHTML = soloOverScreen(s.score, s.wave, best);
    view.querySelector('#again')!.addEventListener('click', () => this.startSolo());
    view.querySelector('#menu')!.addEventListener('click', () => this.showMenu());
    view.querySelector('#share')!.addEventListener('click', async () => {
      const text = `I scored ${s.score.toLocaleString()} on wave ${s.wave} in Orbital Skirmish`;
      try {
        if (navigator.share) await navigator.share({ text, url: location.origin });
        else await navigator.clipboard.writeText(`${text} — ${location.origin}`);
      } catch {
        /* the user dismissed the sheet, or the clipboard is blocked. Not an error. */
      }
    });
  }

  // ── multiplayer ────────────────────────────────────────────────────────────

  private showEntry(): void {
    this.screen = 'entry';
    view.innerHTML = `<div class="screen"><div id="entry"></div></div>`;
    createRoomEntry({
      container: document.getElementById('entry')!,
      onSubmit: (code, created) => void this.enterRoom(code, created),
      onCancel: () => this.showMenu(),
      title: 'Play with friends',
      subtitle: 'Start a room and share the code, or enter a friend’s code to join.',
    });
  }

  /**
   * Join the room ONCE. `created` is the only thing that may claim the host role
   * — a typed code or a link is always a guest, or two peers race to host the
   * same room.
   *
   * Awaits any in-flight teardown first. Without that, leaving a room and
   * rejoining the same code — Menu, then "Play with friends", then type the code
   * you just left — lands inside net.ts's ~99ms teardown window and throws.
   */
  private async enterRoom(rawCode: string, created: boolean): Promise<void> {
    if (this.leaving) await this.leaving;
    const code = normalizeRoomCode(rawCode) || mintCode();
    this.roomCode = code;
    this.match = new Match();
    this.net = createNet(
      { appId: SLUG, roomId: code, claimHost: created },
      {
        onHostChange: (_id, isSelfHost) => {
          // Routes to BOTH: the round core (so a promoted peer keeps simulating)
          // and the lobby (so a promoted peer is told it now owns the mode).
          // `this.ng` is null in the lobby, which is exactly the case the second
          // line exists for.
          this.ng?.onHostChange(isSelfHost);
          if (this.screen === 'lobby') this.paintLobbyMode();
        },
        onPeerLeave: (id) => this.ng?.onPeerLeave(id),
      },
    );
    this.rounds = createRounds({
      net: this.net,
      playerName,
      minPlayers: 2,
      roundOpts: () => ({ mode: this.mode }),
      onRound: (info) => this.startRound(info.seed, info.players, modeOf((info.opts as { mode?: unknown })?.mode).id),
      onChange: () => {
        if (this.screen === 'results') this.paintRematch();
      },
    });
    this.showLobby();
  }

  private async leaveRoom(): Promise<void> {
    this.stopLobbyPoll();
    this.lobby?.destroy();
    this.lobby = null;
    this.rounds?.destroy();
    this.rounds = null;
    const n = this.net;
    this.net = null;
    if (!n) return;
    // Publish the teardown so enterRoom can wait on it. net.ts marks the room
    // 'leaving' and only resolves once Trystero has really let go, so a rejoin
    // that awaits this is safe and one that does not is a thrown error.
    this.leaving = n.leave().finally(() => {
      this.leaving = null;
    });
    await this.leaving;
  }

  private showLobby(): void {
    this.teardownRound();
    this.screen = 'lobby';
    if (!this.net || !this.rounds) return;
    view.innerHTML = `<div class="screen lobby-screen">
      <div id="lobby"></div>
      <div class="lobby-mode" id="lobbymode"></div>
    </div>`;
    this.lobby?.destroy();
    this.lobby = createLobby({
      container: document.getElementById('lobby')!,
      net: this.net,
      rounds: this.rounds,
      roomCode: this.roomCode,
      minPlayers: 2,
      maxPlayers: 4,
      onCancel: () => this.showMenu(),
    });
    this.paintLobbyMode();
    this.startLobbyPoll();
  }

  /**
   * Render the mode block for whatever this peer IS RIGHT NOW.
   *
   * Two rules meet here, and the old code broke both by reading `isHost()` once,
   * at render time:
   *
   *  - Host is not a fact you can sample. It is FALSE until the room settles, and
   *    it flips to true later — on the 2.5s settle election, or when the host
   *    leaves and net.ts promotes you. A guest that rendered a disabled picker
   *    and then became host kept the disabled picker and the caption "The host
   *    picks the mode" forever, while its own roundOpts() was silently what the
   *    whole room was about to play. It could not change the mode, and it was not
   *    told it now owned it.
   *  - Guests must render the host's GOSSIPED pick, never their own local one.
   *
   * So: repaint from a poll (and from onHostChange), idempotently. The innerHTML
   * comparison is what makes 600ms repaints free and keeps them from stomping
   * focus mid-tap.
   */
  private paintLobbyMode(): void {
    const box = document.getElementById('lobbymode');
    if (!box || !this.net || !this.rounds) return;
    const host = this.net.isHost();
    const settled = this.net.hostSettled();
    const gossiped = (this.rounds.state().hostOpts as { mode?: unknown } | null)?.mode;
    const shown = host ? this.mode : modeOf(gossiped).id;
    const html = lobbyModeBlock({ host, settled, mode: shown });
    if (box.innerHTML === html) return;
    box.innerHTML = html;
    if (host) this.wireModes(box);
  }

  private startLobbyPoll(): void {
    this.stopLobbyPoll();
    this.lobbyPoll = setInterval(() => {
      if (this.screen !== 'lobby') return this.stopLobbyPoll();
      this.paintLobbyMode();
    }, 600);
  }

  private stopLobbyPoll(): void {
    if (this.lobbyPoll != null) clearInterval(this.lobbyPoll);
    this.lobbyPoll = null;
  }

  private startRound(seed: number, players: { id: PeerId; name: string }[], mode: ModeId): void {
    this.teardownRound();
    this.screen = 'round';
    this.fx.clear();
    this.roster = players;
    const sim = new Sim({ seed, mode: MODES[mode], players: players.length });
    this.ng = new NetGame(this.net!, sim, players, {
      onEvents: (ev) => {
        this.lastAdvance = Date.now();
        this.playEvents(ev, this.ng?.selfSeat() ?? -1);
      },
      onHostPromoted: () => this.flash("The host left — you're the host now"),
      onOver: () => this.endRound(),
    });

    this.buildArena(`<div class="hud-players" id="hud-players"></div>`, true);
    this.loop = createLoop({
      update: () => {
        this.pollHotkeys();
        this.ng?.setInput(this.counting ? 0 : this.mask());
        this.input?.endFrame();
        this.fx.update(1 / 60);
        this.updateMpHud();
      },
      render: this.draw,
    });
    this.loop.start();

    // Every peer counts locally from the moment the host's start arrived, so
    // they are in step to within one network hop. The round clock is
    // host-authoritative anyway, so that skew costs nobody a kill.
    this.counting = true;
    this.countdown = createCountdown({
      root: view.querySelector('.arena') as HTMLElement,
      sfx,
      reducedMotion: reduced,
      onDone: () => {
        this.counting = false;
        this.countdown = null;
        this.ng?.start();
      },
    });
  }

  private updateMpHud(): void {
    const sim = this.ng?.sim;
    const el = document.getElementById('hud-players');
    if (!sim || !el) return;
    const self = this.ng!.selfSeat();
    const html = sim.ships
      .map((s) => hudRow(s, s.seat === self, this.roster[s.seat]?.name ?? SEAT_NAMES[s.seat] ?? '…'))
      .join('');
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  private flash(msg: string): void {
    const el = document.createElement('div');
    el.className = 'flash show';
    el.textContent = msg;
    (view.querySelector('.arena') ?? view).appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  private endRound(): void {
    const sim = this.ng?.sim;
    if (!sim) return;
    const winnerSeat = sim.winner;
    const winnerId = winnerSeat >= 0 ? (this.roster[winnerSeat]?.id ?? null) : null;
    this.match.record(winnerId, this.roster);
    sfx.play(winnerSeat >= 0 && winnerSeat === this.ng?.selfSeat() ? 'win' : 'lose');

    const rows: ResultsRow[] = sim.ships.map((s) => ({
      seat: s.seat,
      name: this.roster[s.seat]?.name ?? SEAT_NAMES[s.seat] ?? `Seat ${s.seat + 1}`,
      isSelf: s.seat === this.ng?.selfSeat(),
      kills: s.kills,
      deaths: s.deaths,
      shots: s.shots,
      hits: s.hits,
      bestStreak: s.bestStreak,
    }));

    this.teardownRound();
    this.screen = 'results';
    this.rounds?.finish();
    view.innerHTML = resultsScreen({
      rows,
      winnerSeat,
      standings: this.match.standings(),
      rounds: this.match.rounds,
      multiplayer: true,
    });
    this.paintRematch();
  }

  /**
   * The rematch controls. Everything here is a vote inside the LIVING room — no
   * leave, no rejoin, no reload. The countdown is rendered because a silent wait
   * is indistinguishable from a hang, which is exactly how the old build felt.
   */
  private paintRematch(): void {
    const box = document.getElementById('ractions');
    if (!box || !this.rounds) return;
    const st = this.rounds.state();
    const waiting = st.present.length - st.votes.length;
    const secs = st.startsInMs != null ? Math.ceil(st.startsInMs / 1000) : null;
    /**
     * Alone in the room: everyone else closed their tab. A rematch needs two, so
     * no vote of yours can ever start one.
     *
     * This is the case the old note got wrong. It printed "Waiting for 0 more…"
     * — present(1) minus votes(1) — which names nobody, has no countdown, and
     * describes a state that cannot resolve. Rule 12: if a screen can say
     * "waiting", it must say what for and when it ends. Here the honest answer is
     * that it does not end until somebody joins, so say that and hand over the
     * code that makes it possible.
     */
    const alone = st.present.length < 2;

    const html = `
      <button class="btn primary" id="again"${st.voted || alone ? ' disabled' : ''}>${
        st.voted ? 'Ready ✓' : 'Play again'
      }</button>
      ${st.canStart ? '<button class="btn" id="force">Start now</button>' : ''}
      <button class="btn" id="lobby">Back to lobby</button>
      <button class="btn ghost" id="menu">Menu</button>
      <p class="wait-note">${
        alone
          ? `Everyone else left. Share code <b>${esc(this.roomCode)}</b> and they can drop straight back in.`
          : secs != null
            ? `Starting in ${secs}s${waiting > 0 ? ` — waiting on ${waiting}` : ''}`
            : st.voted
              ? `Waiting for ${waiting} more…`
              : `${st.votes.length}/${st.present.length} ready`
      }</p>`;
    if (box.innerHTML !== html) {
      box.innerHTML = html;
      box.querySelector('#again')?.addEventListener('click', () => {
        sfx.play('select');
        this.rounds?.vote();
      });
      box.querySelector('#force')?.addEventListener('click', () => this.rounds?.go());
      // Back to lobby does NOT leave the room.
      box.querySelector('#lobby')?.addEventListener('click', () => this.showLobby());
      box.querySelector('#menu')?.addEventListener('click', () => this.showMenu());
    }
  }

  // ── teardown ───────────────────────────────────────────────────────────────

  private teardownRound(): void {
    this.loop?.stop();
    this.loop = null;
    this.countdown?.cancel();
    this.countdown = null;
    this.counting = false;
    this.input?.destroy();
    this.input = null;
    this.ng?.destroy();
    this.ng = null;
    this.survival = null;
    this.paused = false;
    window.removeEventListener('resize', this.resize);
    this.canvas = null;
    this.ctx = null;
  }
}

new Game();
