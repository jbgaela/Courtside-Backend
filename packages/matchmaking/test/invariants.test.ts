import { describe, expect, it } from 'vitest';
import { MATCHMAKING_DEFAULTS, type MatchmakingConfig } from '@picklequeue/contracts';
import {
  isEligible,
  proposeMatches,
  type MatchmakingCourt,
  type MatchmakingInput,
  type MatchmakingPlayer,
} from '../src/index.js';

/** Deterministic PRNG so every failure can be reproduced by seed. */
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function buildScenario(seed: number): {
  input: MatchmakingInput;
  config: MatchmakingConfig;
} {
  const rng = createRng(seed);
  const playerCount = 1 + Math.floor(rng() * 40);
  const courtCount = Math.floor(rng() * 5);
  const now = 1_700_000_000_000 + seed * 60_000;

  const config: MatchmakingConfig = {
    ...MATCHMAKING_DEFAULTS,
    format: rng() < 0.2 ? 'SINGLES' : 'DOUBLES',
    starvationMaxGap: Math.floor(rng() * 3),
    maxGamesPerPlayer: rng() < 0.2 ? 1 + Math.floor(rng() * 5) : null,
    minRestMinutes: Math.floor(rng() * 6),
  };

  const players: MatchmakingPlayer[] = Array.from({ length: playerCount }, (_, index) => {
    const paused = rng() < 0.12;
    const left = !paused && rng() < 0.08;
    const checkedIn = rng() > 0.1;
    const resting = rng() < 0.15;
    return {
      id: `queue-${seed}-${index}`,
      userId: `user-${seed}-${index}`,
      displayName: `Player ${seed}-${index}`,
      skill: Math.round((1 + rng() * 6) * 4) / 4,
      gamesPlayed: Math.floor(rng() * 8),
      waitingSince: now - Math.floor(rng() * 90) * 60_000,
      checkedIn,
      paused,
      left,
      restUntil: resting ? now + Math.floor(rng() * 10) * 60_000 : null,
      currentAssignmentId: rng() < 0.1 ? `match-${seed}-${index}` : null,
      wins: Math.floor(rng() * 5),
      losses: Math.floor(rng() * 5),
    };
  });

  const courts: MatchmakingCourt[] = Array.from({ length: courtCount }, (_, index) => ({
    id: `court-${seed}-${index}`,
    name: `Court ${index + 1}`,
  }));

  return { input: { now, config, players, courts }, config };
}

describe('matchmaking invariants across generated scenarios', () => {
  it('always produces eligible, unique, complete assignments', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const { input } = buildScenario(seed);
      const result = proposeMatches(input);
      const playersPerMatch = input.config.format === 'SINGLES' ? 2 : 4;
      const eligible = input.players.filter((player) =>
        isEligible(player, input.now, input.config),
      );
      const maxPossible = Math.floor(eligible.length / playersPerMatch);

      expect(result.assignments.length, `seed ${seed}`).toBeLessThanOrEqual(
        Math.min(input.courts.length, maxPossible),
      );

      const selected: string[] = [];
      const usedCourts: string[] = [];
      for (const assignment of result.assignments) {
        const teamA = assignment.teamA.map((player) => player.userId);
        const teamB = assignment.teamB.map((player) => player.userId);
        expect(teamA, `seed ${seed}`).toHaveLength(playersPerMatch / 2);
        expect(teamB, `seed ${seed}`).toHaveLength(playersPerMatch / 2);
        const all = [...teamA, ...teamB];
        expect(new Set(all).size, `seed ${seed} duplicate player`).toBe(all.length);
        selected.push(...all);
        usedCourts.push(assignment.courtId);

        for (const selectedPlayer of [...assignment.teamA, ...assignment.teamB]) {
          const player = input.players.find((row) => row.userId === selectedPlayer.userId)!;
          expect(
            isEligible(player, input.now, input.config),
            `seed ${seed} ineligible selected`,
          ).toBe(true);
        }
      }
      expect(new Set(selected).size, `seed ${seed} player assigned twice`).toBe(selected.length);
      expect(new Set(usedCourts).size, `seed ${seed} court assigned twice`).toBe(usedCourts.length);

      // Every input player appears exactly once, either assigned or benched.
      const benchIds = result.bench.map((player) => player.userId);
      expect(new Set([...selected, ...benchIds]).size, `seed ${seed} missing player`).toBe(
        input.players.length,
      );
      expect(selected.length + benchIds.length, `seed ${seed} duplicated bench row`).toBe(
        input.players.length,
      );
      expect(result.metrics.assignedPlayers).toBe(selected.length);
    }
  });

  it('is deterministic for identical snapshots, including across input ordering', () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      const { input } = buildScenario(seed);
      const first = proposeMatches(input);
      const second = proposeMatches(input);
      expect(second).toEqual(first);

      const reordered: MatchmakingInput = {
        ...input,
        players: [...input.players].reverse(),
        courts: [...input.courts].reverse(),
      };
      const third = proposeMatches(reordered);
      expect(third.assignments.map((row) => row.courtId)).toEqual(
        first.assignments.map((row) => row.courtId),
      );
      expect(
        third.assignments.map((row) => [...row.teamA, ...row.teamB].map((p) => p.userId)),
      ).toEqual(first.assignments.map((row) => [...row.teamA, ...row.teamB].map((p) => p.userId)));
      expect(third.inputHash).toBe(first.inputHash);
    }
  });

  it('adding an ineligible player cannot change the assignment', () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      const { input } = buildScenario(seed);
      if (input.courts.length === 0) continue;
      const before = proposeMatches(input);
      const { config } = input;
      const extra: MatchmakingPlayer = {
        id: 'queue-extra',
        userId: 'user-extra',
        displayName: 'Extra',
        skill: 4,
        gamesPlayed: 0,
        waitingSince: input.now - 60 * 60_000,
        checkedIn: true,
        paused: true,
        left: false,
        restUntil: null,
        currentAssignmentId: null,
        wins: 0,
        losses: 0,
      };
      void config;
      const after = proposeMatches({
        ...input,
        players: [...input.players, extra],
      });
      expect(
        after.assignments.map((row) => [...row.teamA, ...row.teamB].map((p) => p.userId)),
      ).toEqual(before.assignments.map((row) => [...row.teamA, ...row.teamB].map((p) => p.userId)));
    }
  });

  it('respects maxAssignments and never exceeds free courts', () => {
    const { input } = buildScenario(21);
    const withPlayers: MatchmakingInput = {
      ...input,
      courts: Array.from({ length: 6 }, (_, index) => ({
        id: `c-${index}`,
        name: `Court ${index}`,
      })),
      players: Array.from({ length: 40 }, (_, index) => ({
        id: `q-${index}`,
        userId: `u-${index}`,
        displayName: `P${index}`,
        skill: 3,
        gamesPlayed: 0,
        waitingSince: input.now - index * 60_000,
        checkedIn: true,
        paused: false,
        left: false,
        restUntil: null,
        currentAssignmentId: null,
        wins: 0,
        losses: 0,
      })),
      maxAssignments: 2,
    };
    const result = proposeMatches(withPlayers);
    expect(result.assignments).toHaveLength(2);
  });

  it('scales to a 250-player, 16-court stress snapshot without duplicate assignments', () => {
    const now = 1_700_000_000_000;
    const players: MatchmakingPlayer[] = Array.from({ length: 250 }, (_, index) => ({
      id: `q-${index}`,
      userId: `u-${index}`,
      displayName: `Player ${index}`,
      skill: 1 + (index % 25) * 0.25,
      gamesPlayed: index % 3,
      waitingSince: now - (index % 120) * 60_000,
      checkedIn: true,
      paused: false,
      left: false,
      restUntil: null,
      currentAssignmentId: null,
      wins: 0,
      losses: 0,
    }));
    const courts = Array.from({ length: 16 }, (_, index) => ({
      id: `court-${index}`,
      name: `Court ${String(index + 1).padStart(2, '0')}`,
    }));
    const started = Date.now();
    const result = proposeMatches({
      now,
      config: { ...MATCHMAKING_DEFAULTS, starvationMaxGap: 1 },
      players,
      courts,
    });
    const elapsed = Date.now() - started;

    expect(result.assignments).toHaveLength(16);
    const selected = result.assignments.flatMap((row) =>
      [...row.teamA, ...row.teamB].map((player) => player.userId),
    );
    expect(new Set(selected).size).toBe(64);
    expect(new Set(result.assignments.map((row) => row.courtId)).size).toBe(16);
    expect(elapsed).toBeLessThan(5_000);
  });
});
