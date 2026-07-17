/**
 * room-code.test.ts — CONTRACT GATE #1: a typed code must reach the same room.
 *
 * People do not only click invite links. They read the code aloud, paste it into
 * a chat, or type it on a different device — and every one of those arrives
 * lower-cased, with a stray space, or with a dash someone added for legibility.
 * If normalizeRoomCode does not fold all of those onto the exact string the
 * invite link carries, the two players land in DIFFERENT Trystero rooms while
 * both looking at what appears to be the same code, and sit there alone.
 *
 * That failure is invisible from one browser, which is why it is a unit test.
 */

import { describe, expect, it } from 'vitest';
import { clearRoomInUrl, inviteLink, mintCode, normalizeRoomCode } from '../src/engine/lobby';

describe('normalizeRoomCode', () => {
  it('folds a hand-typed code onto the canonical one', () => {
    const canonical = normalizeRoomCode('QK4T');
    for (const typed of ['qk4t', ' QK4T ', 'qk-4t', 'Q K 4 T', 'qk4t\n', 'QK4T.']) {
      expect(normalizeRoomCode(typed), typed).toBe(canonical);
    }
  });

  it('strips anything that is not A-Z or 0-9', () => {
    expect(normalizeRoomCode('a1!b2@c3#')).toBe('A1B2C3');
  });

  it('caps at 8 characters, so a pasted URL cannot become a room id', () => {
    expect(normalizeRoomCode('ABCDEFGHIJKLMNOP').length).toBe(8);
  });

  it('is idempotent — normalising twice changes nothing', () => {
    const once = normalizeRoomCode('  qk-4t ');
    expect(normalizeRoomCode(once)).toBe(once);
  });

  it('empty and junk-only input normalise to empty rather than throwing', () => {
    expect(normalizeRoomCode('')).toBe('');
    expect(normalizeRoomCode('---')).toBe('');
    expect(normalizeRoomCode('  ')).toBe('');
  });
});

describe('minted codes', () => {
  it('survive a round trip through normalisation unchanged', () => {
    // If mint could emit a character normalise strips, the host would advertise
    // a code that nobody can type back in.
    for (let i = 0; i < 200; i++) {
      const c = mintCode();
      expect(normalizeRoomCode(c)).toBe(c);
    }
  });

  it('avoid the characters people misread aloud', () => {
    // No I/O/0/1/L — "was that an oh or a zero" is a support ticket.
    for (let i = 0; i < 200; i++) expect(mintCode()).not.toMatch(/[IO01L]/);
  });
});

describe('the invite link and the typed code agree', () => {
  it('a link built from a code carries exactly that code', () => {
    const code = mintCode();
    const url = new URL(inviteLink(code));
    expect(normalizeRoomCode(url.searchParams.get('room') ?? '')).toBe(code);
  });

  it('clearRoomInUrl removes it, so a reload does not rejoin', () => {
    // Principle 11: a room is a choice, not a destiny. Leaving ?room= in the URL
    // means a reload — or reopening from a home-screen icon — silently drags the
    // player back into a room they left.
    history.replaceState(null, '', '/?room=QK4T');
    clearRoomInUrl();
    expect(new URL(location.href).searchParams.get('room')).toBeNull();
  });
});
