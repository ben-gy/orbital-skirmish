/**
 * ui.ts — every screen that is not the arena.
 *
 * View builders only: they take data and return markup, and the caller wires the
 * buttons. Nothing here reads the Sim directly, which is what keeps the results
 * screen renderable from a snapshot on a peer that died two minutes ago.
 */

import { seatColor } from './render';
import type { Ship } from './game/sim';
import type { Standing } from './match';
import { MODE_LIST, type Mode, type ModeId } from './modes';

export const FOOTER = `<footer class="site-footer">Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a> · <a href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a></footer>`;

export function esc(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

export function modePicker(current: ModeId, disabled = false): string {
  return `<div class="modes" role="radiogroup" aria-label="Mode">${MODE_LIST.map(
    (m) => `<button class="mode${m.id === current ? ' on' : ''}" role="radio" aria-checked="${m.id === current}"
      data-mode="${m.id}"${disabled ? ' disabled' : ''}>
      <span class="mode-name">${m.name}</span><span class="mode-blurb">${m.blurb}</span></button>`,
  ).join('')}</div>`;
}

/**
 * The arena shell. `live` = a P2P round, and it changes what the top-right
 * control IS — not just what it says.
 *
 * You cannot pause a live P2P round: the host keeps simulating whatever this tab
 * does. The first version shipped a button labelled "Pause", with a ❚❚ glyph,
 * sitting next to the mute toggle — and in a room one tap tore the room down and
 * dumped you to the title screen. No confirmation, no results screen, and your
 * opponent left alone. In a room this is a LEAVE control: it says so, it warns
 * what leaving costs, and it asks first.
 */
export function arenaShell(hud: string, live: boolean, muted: boolean): string {
  return `<div class="arena">
      <canvas id="cv" aria-label="Arena"></canvas>
      <div class="hud" id="hud">${hud}</div>
      <div class="hud-right">
        <button class="icon-btn" id="mute" aria-label="Mute">${muted ? '🔇' : '🔊'}</button>
        <button class="icon-btn" id="pause" aria-label="${live ? 'Leave match' : 'Pause'}">${live ? '✕' : '❚❚'}</button>
      </div>
      <div class="overlay" id="pauseo" hidden>
        <div class="overlay-card">
          <h2>${live ? 'Leave the match?' : 'Paused'}</h2>
          ${
            live
              ? '<p class="overlay-note">The round carries on without you — you won’t see the results, and you’ll leave the room.</p>'
              : ''
          }
          <button class="btn primary" id="resume">${live ? 'Keep playing' : 'Resume'}</button>
          ${live ? '' : '<button class="btn" id="restart">Restart</button>'}
          <button class="btn ghost" id="quit">${live ? 'Leave match' : 'Menu'}</button>
        </div>
      </div>
    </div>`;
}

/**
 * The lobby's mode block, for whatever this peer IS RIGHT NOW.
 *
 * `host` is not a fact you read once at render time: it is false until the room
 * settles, and it flips to true on the settle election or when the host leaves
 * and net.ts promotes you. Rendering this once left a promoted peer with a
 * permanently disabled picker captioned "The host picks the mode" — while its
 * own roundOpts() was, silently, what the whole room was about to play.
 */
export function lobbyModeBlock(o: { host: boolean; settled: boolean; mode: ModeId }): string {
  const caption = !o.settled
    ? 'Connecting…'
    : o.host
      ? 'Your pick — everyone plays it'
      : 'The host picks the mode';
  return `<p class="lobby-mode-h">${caption}</p>${modePicker(o.mode, !o.host)}`;
}

export function menuScreen(mode: ModeId, best: { score: number; wave: number }): string {
  return `<div class="screen menu">
    <h1 class="title">Orbital<span>Skirmish</span></h1>
    <p class="tagline">Thrust, slingshot around the star, and be the last ship flying.</p>
    ${modePicker(mode)}
    <div class="menu-actions">
      <button class="btn primary" id="play">Play</button>
      <button class="btn" id="friends">Play with friends</button>
    </div>
    ${best.score > 0 ? `<p class="best">Best: <b>${best.score.toLocaleString()}</b> · wave ${best.wave}</p>` : ''}
    <div class="menu-links">
      <button class="link" id="help">How to play</button>
      <button class="link" id="about">About</button>
    </div>
  </div>`;
}

export function helpScreen(): string {
  return `<div class="panel-body">
    <h2>How to play</h2>
    <p><b>Rotate and thrust — you keep your momentum, so plan the stop before the go.</b></p>
    <p>The star at the centre pulls you, your rivals and every bullet in flight: curve your shots around it, and don't let it eat you. The rocks and the rim bite too.</p>
    <p><b>Last ship flying wins.</b> You have five lives.</p>
    <ul class="keys">
      <li><kbd>←</kbd><kbd>→</kbd> or <kbd>A</kbd><kbd>D</kbd> — rotate</li>
      <li><kbd>↑</kbd> or <kbd>W</kbd> — thrust</li>
      <li><kbd>Space</kbd> — fire</li>
      <li><kbd>P</kbd> pause · <kbd>M</kbd> mute</li>
    </ul>
    <p class="muted">On a phone: use the pad on the left and the fire button on the right.</p>
  </div>`;
}

export function aboutScreen(): string {
  return `<div class="panel-body">
    <h2>About</h2>
    <p>Orbital Skirmish is a momentum dogfight in a gravity well. Everything you see is drawn procedurally and every sound is synthesised in your browser — there are no images, no fonts and no audio files to download.</p>
    <p><b>Multiplayer is peer-to-peer.</b> Your browser talks straight to your friends' browsers over WebRTC; there is no game server and no account. A free public signalling relay is used only to introduce the browsers to each other — after that, nothing about your game touches it, and nothing is stored on a server.</p>
    <p class="muted">No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less page-view counts via Cloudflare Web Analytics.</p>
    ${FOOTER}
  </div>`;
}

/** A live-round HUD line for one ship. */
export function hudRow(s: Ship, isSelf: boolean, name: string): string {
  return `<div class="hud-p${s.out ? ' out' : ''}${isSelf ? ' self' : ''}">
    <span class="dot" style="background:${seatColor(s.seat)}"></span>
    <span class="hp-name">${esc(name)}</span>
    <span class="hp-lives">${s.out ? '—' : '♦'.repeat(Math.max(0, s.lives))}</span>
    <span class="hp-kills">${s.kills}</span>
  </div>`;
}

export interface ResultsRow {
  seat: number;
  name: string;
  isSelf: boolean;
  kills: number;
  deaths: number;
  shots: number;
  hits: number;
  bestStreak: number;
}

/**
 * The one moment players compare themselves — so it shows EVERYONE.
 *
 * Not a name and a number: what each player actually did. A summary that only
 * reflects you back at yourself wastes the screen (principle 9), and every peer
 * reaches this, including one that died in the first ten seconds and one whose
 * host went silent.
 */
export function resultsScreen(o: {
  rows: ResultsRow[];
  winnerSeat: number;
  standings: Standing[];
  rounds: number;
  multiplayer: boolean;
}): string {
  const rows = [...o.rows].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  const win = o.rows.find((r) => r.seat === o.winnerSeat);
  const headline = !win
    ? 'Draw'
    : win.isSelf
      ? 'You win'
      : `${esc(win.name)} wins`;

  const table = `<table class="results"><thead><tr>
      <th>Pilot</th><th>Kills</th><th>Deaths</th><th>Streak</th><th>Acc.</th>
    </tr></thead><tbody>${rows
      .map(
        (r) => `<tr class="${r.isSelf ? 'self' : ''}${r.seat === o.winnerSeat ? ' won' : ''}">
        <td><span class="dot" style="background:${seatColor(r.seat)}"></span>${esc(r.name)}${
          r.seat === o.winnerSeat ? ' <span class="crown">★</span>' : ''
        }</td>
        <td>${r.kills}</td><td>${r.deaths}</td><td>${r.bestStreak}</td>
        <td>${r.shots ? Math.round((r.hits / r.shots) * 100) : 0}%</td>
      </tr>`,
      )
      .join('')}</tbody></table>`;

  const tally =
    o.multiplayer && o.standings.length
      ? `<div class="tally"><h3>Match — ${o.rounds} round${o.rounds === 1 ? '' : 's'}</h3>
        ${o.standings.map((s) => `<div class="tally-row"><span>${esc(s.name)}</span><b>${s.wins}</b></div>`).join('')}</div>`
      : '';

  return `<div class="screen results-screen">
    <h2 class="headline">${headline}</h2>
    ${table}
    ${tally}
    <div class="results-actions" id="ractions"></div>
  </div>`;
}

export function soloOverScreen(score: number, wave: number, best: { score: number; wave: number }): string {
  const isBest = score >= best.score && score > 0;
  return `<div class="screen results-screen">
    <h2 class="headline">${isBest ? 'New best' : 'Run over'}</h2>
    <p class="bigscore">${score.toLocaleString()}</p>
    <p class="submeta">Reached wave <b>${wave}</b>${!isBest && best.score ? ` · best ${best.score.toLocaleString()}` : ''}</p>
    <div class="results-actions">
      <button class="btn primary" id="again">Play again</button>
      <button class="btn" id="share">Share score</button>
      <button class="btn ghost" id="menu">Menu</button>
    </div>
  </div>`;
}

export function modeLabel(m: Mode): string {
  return `<span class="mode-chip">${m.name}</span>`;
}
