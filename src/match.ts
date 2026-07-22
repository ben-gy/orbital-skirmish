// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * match.ts — the running tally across rounds in one room.
 *
 * Keyed by PEER ID, not seat. Seats are frozen per round and a peer who sits out
 * a round (or joins late) gets a different index in the next one — tallying by
 * seat would quietly hand your wins to whoever inherits your slot. The id is the
 * only thing that is stable for the life of the room.
 *
 * This is the thing that makes a rematch a match rather than a repeat: without a
 * tally, round two is just round one again with the same people.
 */

export interface Standing {
  id: string;
  name: string;
  wins: number;
}

export class Match {
  private wins = new Map<string, number>();
  private names = new Map<string, string>();
  rounds = 0;

  record(winnerId: string | null, roster: { id: string; name: string }[]): void {
    this.rounds++;
    for (const p of roster) this.names.set(p.id, p.name);
    if (!winnerId) return; // a draw still counts as a round played
    this.wins.set(winnerId, (this.wins.get(winnerId) ?? 0) + 1);
  }

  /** Everyone who has appeared in this room, best first. */
  standings(): Standing[] {
    return [...this.names.entries()]
      .map(([id, name]) => ({ id, name, wins: this.wins.get(id) ?? 0 }))
      .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name));
  }

  winsFor(id: string): number {
    return this.wins.get(id) ?? 0;
  }
}
