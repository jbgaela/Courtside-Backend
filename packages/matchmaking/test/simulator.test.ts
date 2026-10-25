import { describe, expect, it } from 'vitest';
import { MATCHMAKING_DEFAULTS } from '@picklequeue/contracts';
import { runSimulation, type SimulationPlayerInput } from '../src/index.js';

function roster(count: number, skillMode: 'tight' | 'wide' = 'tight'): SimulationPlayerInput[] {
  return Array.from({ length: count }, (_, index) => ({
    userId: `p${index + 1}`,
    displayName: `Player ${index + 1}`,
    skill: skillMode === 'tight' ? 3 + ((index % 5) - 2) * 0.25 : 2 + ((index * 7) % 16) * 0.1875,
    initialWaitMinutes: index % 3,
  }));
}

describe('runSimulation', () => {
  it('is reproducible for the same seed and roster', () => {
    const options = {
      seed: 12345,
      players: roster(20),
      courtCount: 2,
      rounds: 24,
      config: { ...MATCHMAKING_DEFAULTS, format: 'DOUBLES' as const },
    };
    const first = runSimulation(options);
    const second = runSimulation(options);
    expect(second).toEqual(first);
    expect(first.inputHashes).toEqual(second.inputHashes);
  });

  it('keeps play-count disparity within the documented fairness threshold', () => {
    const report = runSimulation({
      seed: 424242,
      players: roster(20),
      courtCount: 2,
      rounds: 30,
      warmupRounds: 5,
    });
    expect(report.maxPlayDisparity).toBeLessThanOrEqual(3);
    expect(report.starvationIncidents).toBe(0);
    expect(report.courtUtilization).toBeGreaterThan(0.85);
    expect(report.perPlayer.every((player) => player.gamesPlayed > 0)).toBe(true);
  });

  it('remains fair with a wide skill distribution', () => {
    const report = runSimulation({
      seed: 77,
      players: roster(16, 'wide'),
      courtCount: 2,
      rounds: 24,
    });
    expect(report.maxPlayDisparity).toBeLessThanOrEqual(3);
    expect(report.perPlayer.every((player) => player.gamesPlayed > 0)).toBe(true);
  });

  it('never produces duplicate participants or malformed matches', () => {
    for (const seed of [1, 2, 3, 9, 55, 777]) {
      const report = runSimulation({
        seed,
        players: roster(17, seed % 2 === 0 ? 'wide' : 'tight'),
        courtCount: 3,
        rounds: 18,
      });
      for (const game of report.games) {
        const ids = [...game.teamAUserIds, ...game.teamBUserIds];
        expect(new Set(ids).size).toBe(ids.length);
        expect(game.teamAUserIds).toHaveLength(2);
        expect(game.teamBUserIds).toHaveLength(2);
        expect(game.scoreA).not.toBe(game.scoreB);
      }
    }
  });

  it('honours a per-player game cap', () => {
    const report = runSimulation({
      seed: 91,
      players: roster(12),
      courtCount: 2,
      rounds: 30,
      config: { ...MATCHMAKING_DEFAULTS, maxGamesPerPlayer: 3 },
    });
    expect(report.perPlayer.every((player) => player.gamesPlayed <= 3)).toBe(true);
  });

  it('reports zero utilization when there are no courts', () => {
    const report = runSimulation({
      seed: 5,
      players: roster(8),
      courtCount: 0,
      rounds: 4,
    });
    expect(report.games).toHaveLength(0);
    expect(report.courtUtilization).toBe(0);
  });

  it('supports singles simulations', () => {
    const report = runSimulation({
      seed: 8,
      players: roster(10),
      courtCount: 2,
      rounds: 12,
      format: 'SINGLES',
    });
    for (const game of report.games) {
      expect(game.teamAUserIds).toHaveLength(1);
      expect(game.teamBUserIds).toHaveLength(1);
    }
  });

  it('never reports court utilisation above 100% after warm-up', () => {
    for (const seed of [3, 21, 99]) {
      const report = runSimulation({
        seed,
        players: roster(30),
        courtCount: 3,
        rounds: 20,
        warmupRounds: 5,
      });
      expect(report.courtUtilization, `seed ${seed}`).toBeLessThanOrEqual(1);
      expect(report.courtUtilization, `seed ${seed}`).toBeGreaterThan(0.5);
    }
  });

  it('keeps a 100-player, 8-court soak fair across deterministic seeds', () => {
    for (const seed of [11, 22, 33]) {
      const report = runSimulation({
        seed,
        players: roster(100, 'wide'),
        courtCount: 8,
        rounds: 60,
        warmupRounds: 5,
      });
      expect(report.maxPlayDisparity, `seed ${seed}`).toBeLessThanOrEqual(3);
      expect(report.starvationIncidents, `seed ${seed}`).toBe(0);
      expect(report.courtUtilization, `seed ${seed}`).toBeGreaterThan(0.9);
      expect(
        report.perPlayer.every((player) => player.gamesPlayed > 0),
        `seed ${seed}`,
      ).toBe(true);
    }
  });

  it('keeps a 50-player, 4-court session fair under a mixed skill pool', () => {
    for (const seed of [101, 202, 303]) {
      const report = runSimulation({
        seed,
        players: roster(50, 'wide'),
        courtCount: 4,
        rounds: 48,
        warmupRounds: 4,
      });
      expect(report.maxPlayDisparity, `seed ${seed}`).toBeLessThanOrEqual(3);
      expect(report.starvationIncidents, `seed ${seed}`).toBe(0);
      expect(report.courtUtilization, `seed ${seed}`).toBeGreaterThan(0.85);
    }
  });
});
