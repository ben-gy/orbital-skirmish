/**
 * ui.test.ts — the two screens that lied to the player.
 *
 * Both of these shipped in the first cut and were caught by an adversarial
 * review rather than by any of the other 180 tests, because both are perfectly
 * correct code doing exactly the wrong thing. Neither is a rendering bug; both
 * are a control claiming to be something it is not.
 */

import { describe, expect, it } from 'vitest';
import { arenaShell, lobbyModeBlock, resultsScreen } from '../src/ui';

describe('the arena control means what it says', () => {
  const solo = arenaShell('<div/>', false, false);
  const live = arenaShell('<div/>', true, false);

  it('solo gets a real Pause, because solo can really pause', () => {
    expect(solo).toContain('aria-label="Pause"');
    expect(solo).toContain('❚❚');
    expect(solo).toContain('>Paused<');
    expect(solo).toContain('id="resume"');
    expect(solo).toContain('>Resume<');
    expect(solo).toContain('id="restart"');
  });

  it('a live round gets a LEAVE control, not a Pause', () => {
    // A live P2P round cannot pause: the host keeps simulating whatever this tab
    // does. Shipping a ❚❚ labelled "Pause" next to the mute toggle, which then
    // tore the room down on ONE TAP with no confirmation, is the bug this pins.
    expect(live).toContain('aria-label="Leave match"');
    expect(live).not.toContain('aria-label="Pause"');
    expect(live).not.toContain('❚❚');
  });

  it('and it asks first, and says what leaving costs', () => {
    expect(live).toContain('Leave the match?');
    expect(live).toContain('id="resume"'); // the "no" button
    expect(live).toContain('Keep playing');
    expect(live).toMatch(/carries on without you/i);
  });

  it('a live round offers no Restart — the round is not this tab`s to restart', () => {
    expect(live).not.toContain('id="restart"');
  });

  it('the overlay starts hidden in both, and the [hidden] gate handles the rest', () => {
    expect(solo).toContain('id="pauseo" hidden');
    expect(live).toContain('id="pauseo" hidden');
  });
});

describe('the lobby mode block reflects what this peer IS, not what it was', () => {
  it('a host is told the pick is theirs, and can make it', () => {
    const h = lobbyModeBlock({ host: true, settled: true, mode: 'skirmish' });
    expect(h).toContain('Your pick');
    expect(h).not.toContain('disabled');
  });

  it('a guest is told the host picks, and cannot', () => {
    const g = lobbyModeBlock({ host: false, settled: true, mode: 'nova' });
    expect(g).toContain('The host picks the mode');
    expect(g).toContain('disabled');
  });

  it('an unsettled peer claims nothing at all', () => {
    // isHost() is false until the room settles. Rendering "The host picks the
    // mode" during that window tells a peer that may be about to BE the host
    // that it is not — and net.ts deliberately withholds the answer until the
    // mesh has formed, so "connecting" is the only honest caption.
    const c = lobbyModeBlock({ host: false, settled: false, mode: 'skirmish' });
    expect(c).toContain('Connecting');
    expect(c).not.toContain('The host picks the mode');
  });

  it('a peer promoted to host gets an ENABLED picker — the whole bug', () => {
    // The block is re-rendered from live state on promotion. The first cut read
    // isHost() once at render time, so a guest promoted when the host quit kept
    // a disabled picker captioned "The host picks the mode" forever — while its
    // own roundOpts() was silently what the room was about to play.
    const before = lobbyModeBlock({ host: false, settled: true, mode: 'skirmish' });
    const after = lobbyModeBlock({ host: true, settled: true, mode: 'skirmish' });
    expect(before).toContain('disabled');
    expect(after).not.toContain('disabled');
    expect(after).not.toBe(before);
  });

  it('is byte-identical for identical state, so a 600ms repaint is free', () => {
    // paintLobbyMode compares innerHTML before writing; if this were not stable
    // the lobby would re-render every tick and eat taps mid-press.
    expect(lobbyModeBlock({ host: true, settled: true, mode: 'belt' })).toBe(
      lobbyModeBlock({ host: true, settled: true, mode: 'belt' }),
    );
  });
});

describe('the results screen', () => {
  const rows = [
    { seat: 0, name: 'Ana', isSelf: true, kills: 3, deaths: 1, shots: 10, hits: 3, bestStreak: 2 },
    { seat: 1, name: 'Bo', isSelf: false, kills: 1, deaths: 3, shots: 8, hits: 1, bestStreak: 1 },
  ];

  it('shows EVERY player`s breakdown, not just yours (principle 9)', () => {
    const h = resultsScreen({ rows, winnerSeat: 0, standings: [], rounds: 1, multiplayer: true });
    expect(h).toContain('Ana');
    expect(h).toContain('Bo');
    // Kills, deaths, streak and accuracy for both — a name and a number is not
    // a breakdown.
    expect(h).toContain('30%'); // Ana 3/10
    expect(h).toContain('13%'); // Bo 1/8
  });

  it('escapes player names — they arrive off the wire', () => {
    const evil = [{ ...rows[0], name: '<img src=x onerror=alert(1)>' }];
    const h = resultsScreen({ rows: evil, winnerSeat: 0, standings: [], rounds: 1, multiplayer: true });
    expect(h).not.toContain('<img src=x');
    expect(h).toContain('&lt;img');
  });

  it('crowns a draw as a draw', () => {
    const h = resultsScreen({ rows, winnerSeat: -1, standings: [], rounds: 1, multiplayer: true });
    expect(h).toContain('Draw');
  });

  it('names the winner when it is not you', () => {
    const h = resultsScreen({ rows, winnerSeat: 1, standings: [], rounds: 1, multiplayer: true });
    expect(h).toContain('Bo wins');
  });

  it('shows the match tally, which is what makes a rematch a match', () => {
    const h = resultsScreen({
      rows,
      winnerSeat: 0,
      standings: [{ id: 'a', name: 'Ana', wins: 2 }, { id: 'b', name: 'Bo', wins: 1 }],
      rounds: 3,
      multiplayer: true,
    });
    expect(h).toContain('3 rounds');
    expect(h).toContain('Ana');
  });
});
