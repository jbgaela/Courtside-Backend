import { describe, expect, it } from 'vitest';
import { MATCHMAKING_DEFAULTS, type MatchmakingConfig } from '@picklequeue/contracts';
import {
  proposeMatches,
  type MatchmakingCourt,
  type MatchmakingInput,
  type MatchmakingPlayer,
  type RecentMatch,
} from '../src/index.js';

const NOW = 1_800_000_000_000;

function config(overrides: Partial<MatchmakingConfig> = {}): MatchmakingConfig {
  return {
    ...MATCHMAKING_DEFAULTS,
    format: 'DOUBLES',
    preferredSkillSpread: 1.5,
    maxSkillSpread: 2,
    widenAfterMinutes: 10,
    ...overrides,
  };
}

function player(userId: string, overrides: Partial<MatchmakingPlayer> = {}): MatchmakingPlayer {
  return {
    id: `q-${userId}`,
    userId,
    displayName: userId,
    skill: 3.5,
    gamesPlayed: 0,
    waitingSince: NOW,
    checkedIn: true,
    paused: false,
    left: false,
    restUntil: null,
    currentAssignmentId: null,
    wins: 0,
    losses: 0,
    ...overrides,
  };
}

const COURTS: MatchmakingCourt[] = [
  { id: 'court-1', name: 'Court 1' },
  { id: 'court-2', name: 'Court 2' },
  { id: 'court-3', name: 'Court 3' },
];

function input(
  players: MatchmakingPlayer[],
  overrides: Partial<MatchmakingInput> = {},
): MatchmakingInput {
  return {
    now: NOW,
    config: config(),
    players,
    courts: COURTS,
    recentMatches: [],
    ...overrides,
  };
}

function allUserIds(result: ReturnType<typeof proposeMatches>): string[] {
  return result.assignments.flatMap((assignment) =>
    [...assignment.teamA, ...assignment.teamB].map((selected) => selected.userId),
  );
}

describe('proposeMatches', () => {
  it('is deterministic for identical snapshots', () => {
    const players = Array.from({ length: 12 }, (_, index) =>
      player(`u${index + 1}`, {
        skill: 2.5 + (index % 6) * 0.25,
        gamesPlayed: index % 3,
        waitingSince: NOW - index * 60_000,
      }),
    );
    const first = proposeMatches(input(players, { config: config({ starvationMaxGap: 2 }) }));
    const second = proposeMatches(input(players, { config: config({ starvationMaxGap: 2 }) }));
    expect(second).toEqual(first);
    expect(first.assignments).toHaveLength(3);
  });

  it('never assigns a player twice across multiple courts', () => {
    const players = Array.from({ length: 24 }, (_, index) =>
      player(`u${index + 1}`, {
        skill: 2 + (index % 9) * 0.25,
        waitingSince: NOW - index * 30_000,
      }),
    );
    const result = proposeMatches(input(players));
    const ids = allUserIds(result);
    expect(result.assignments).toHaveLength(3);
    expect(new Set(ids).size).toBe(ids.length);
    for (const assignment of result.assignments) {
      expect(assignment.teamA).toHaveLength(2);
      expect(assignment.teamB).toHaveLength(2);
    }
  });

  it('excludes paused, left, resting, unchecked and reserved players', () => {
    const players = [
      player('ok1'),
      player('ok2'),
      player('ok3'),
      player('ok4'),
      player('paused', { paused: true }),
      player('left', { left: true }),
      player('resting', { restUntil: NOW + 60_000 }),
      player('unchecked', { checkedIn: false }),
      player('reserved', { currentAssignmentId: 'assignment-1' }),
    ];
    const result = proposeMatches(input(players));
    expect(result.metrics.eligiblePlayers).toBe(4);
    expect(allUserIds(result).sort()).toEqual(['ok1', 'ok2', 'ok3', 'ok4']);
    expect(result.warnings).toEqual([]);
  });

  it('prioritizes the lowest games-played tier', () => {
    const players = [
      ...Array.from({ length: 4 }, (_, index) => player(`fresh${index + 1}`, { gamesPlayed: 0 })),
      ...Array.from({ length: 4 }, (_, index) => player(`veteran${index + 1}`, { gamesPlayed: 3 })),
    ];
    const result = proposeMatches(input(players));
    expect(allUserIds(result).sort()).toEqual(['fresh1', 'fresh2', 'fresh3', 'fresh4']);
  });

  it('prioritizes the longest accumulated wait within the same games tier', () => {
    const players = Array.from({ length: 8 }, (_, index) =>
      player(`u${index + 1}`, {
        waitingSince: NOW - (8 - index) * 5 * 60_000,
      }),
    );
    const result = proposeMatches(input(players, { maxAssignments: 1 }));
    expect(allUserIds(result).sort()).toEqual(['u1', 'u2', 'u3', 'u4']);
  });

  it('balances doubles teams across all three partitions', () => {
    const skills = [5, 2, 3, 4];
    const players = skills.map((skill, index) =>
      player(`u${index + 1}`, { skill, waitingSince: NOW - index * 60_000 }),
    );
    const result = proposeMatches(
      input(players, {
        config: config({ preferredSkillSpread: 3, maxSkillSpread: 3, widenAfterMinutes: 0 }),
      }),
    );
    expect(result.assignments).toHaveLength(1);
    const match = result.assignments[0]!;
    expect(match.teamBalance).toBe(0);
    expect(match.teamRatingA + match.teamRatingB).toBe(14);
  });

  it('prefers new partnerships when skill and fairness are equal', () => {
    const players = Array.from({ length: 8 }, (_, index) => player(`u${index + 1}`));
    const recent: RecentMatch[] = [
      {
        id: 'recent-1',
        round: 1,
        completedAt: NOW - 10 * 60_000,
        teamAUserIds: ['u1', 'u2'],
        teamBUserIds: ['u3', 'u4'],
      },
    ];
    const result = proposeMatches(
      input(players, {
        maxAssignments: 1,
        recentMatches: recent,
        config: config({ partnerPenalty: 50, opponentPenalty: 50 }),
      }),
    );
    const assignment = result.assignments[0]!;
    const sameTeam = (a: string, b: string) =>
      (assignment.teamA.some((p) => p.userId === a) &&
        assignment.teamA.some((p) => p.userId === b)) ||
      (assignment.teamB.some((p) => p.userId === a) &&
        assignment.teamB.some((p) => p.userId === b));
    expect(sameTeam('u1', 'u2')).toBe(false);
    expect(sameTeam('u3', 'u4')).toBe(false);
  });

  it('applies rest and game caps', () => {
    const players = [
      player('capped', { gamesPlayed: 2 }),
      ...Array.from({ length: 4 }, (_, index) => player(`u${index + 2}`)),
    ];
    const result = proposeMatches(input(players, { config: config({ maxGamesPerPlayer: 2 }) }));
    expect(allUserIds(result)).not.toContain('capped');
    expect(result.bench.find((entry) => entry.userId === 'capped')?.reason).toBe(
      'Reached game cap',
    );
  });

  it('returns no assignment when fewer than four doubles players are eligible', () => {
    const result = proposeMatches(input([player('u1'), player('u2'), player('u3')]));
    expect(result.assignments).toEqual([]);
    expect(result.metrics.eligiblePlayers).toBe(3);
    expect(result.bench).toHaveLength(3);
  });

  it('protects fairness by excluding players well above the minimum games tier', () => {
    const players = [
      ...Array.from({ length: 4 }, (_, index) => player(`fresh${index + 1}`)),
      ...Array.from({ length: 4 }, (_, index) => player(`veteran${index + 1}`, { gamesPlayed: 5 })),
    ];
    const result = proposeMatches(input(players));
    expect(allUserIds(result).sort()).toEqual(['fresh1', 'fresh2', 'fresh3', 'fresh4']);
    expect(result.bench.some((entry) => entry.reason.includes('Fairness guard'))).toBe(true);
  });

  it('widens the games gap rather than stalling when the fairness pool is too small', () => {
    const players = [
      ...Array.from({ length: 3 }, (_, index) => player(`fresh${index + 1}`)),
      ...Array.from({ length: 5 }, (_, index) => player(`veteran${index + 1}`, { gamesPlayed: 5 })),
    ];
    const result = proposeMatches(input(players));
    expect(result.assignments).toHaveLength(2);
    expect(result.warnings.join(' ')).toContain('games-played gap');
  });

  it('uses a warned mixed-skill fallback rather than starving waiting players', () => {
    const players = [
      player('low1', { skill: 2, waitingSince: NOW - 40 * 60_000 }),
      player('low2', { skill: 2.1, waitingSince: NOW - 39 * 60_000 }),
      player('high1', { skill: 5, waitingSince: NOW - 38 * 60_000 }),
      player('high2', { skill: 5.1, waitingSince: NOW - 37 * 60_000 }),
    ];
    const result = proposeMatches(
      input(players, {
        config: config({
          preferredSkillSpread: 0.25,
          maxSkillSpread: 0.5,
          widenAfterMinutes: 10,
          allowMixedSkillFallback: true,
        }),
      }),
    );
    expect(result.assignments).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('Mixed-skill fallback');
  });

  it('supports singles without duplicate players', () => {
    const players = Array.from({ length: 8 }, (_, index) =>
      player(`u${index + 1}`, { skill: 3 + (index % 3) * 0.25 }),
    );
    const result = proposeMatches(input(players, { config: config({ format: 'SINGLES' }) }));
    expect(result.assignments).toHaveLength(3);
    for (const assignment of result.assignments) {
      expect(assignment.teamA).toHaveLength(1);
      expect(assignment.teamB).toHaveLength(1);
    }
    const ids = allUserIds(result);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces a stable input hash that changes with eligibility state', () => {
    const base = player('u1');
    const players = [base, player('u2'), player('u3'), player('u4')];
    const first = proposeMatches(input(players));
    const second = proposeMatches(input([{ ...base, paused: true }, ...players.slice(1)]));
    expect(first.inputHash).not.toBe(second.inputHash);
    expect(first.inputHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('keeps all waiting players in the bench or assignment set', () => {
    const players = Array.from({ length: 11 }, (_, index) =>
      player(`u${index + 1}`, { gamesPlayed: index % 2 }),
    );
    const result = proposeMatches(input(players, { maxAssignments: 1 }));
    const assigned = new Set(allUserIds(result));
    const benched = new Set(result.bench.map((entry) => entry.userId));
    expect(assigned.size + benched.size).toBe(players.length);
    for (const playerEntry of players) {
      expect(assigned.has(playerEntry.userId) || benched.has(playerEntry.userId)).toBe(true);
    }
  });
});
