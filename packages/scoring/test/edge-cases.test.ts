import { describe, expect, it } from 'vitest';
import type { ScoringConfig } from '@picklequeue/contracts';
import { gameWinner, isGameWon, validateCorrectedGames } from '../src/index.js';

const CAPPED: ScoringConfig = {
  mode: 'RALLY',
  targetScore: 11,
  winByTwo: true,
  pointCap: 15,
  bestOf: 1,
};

describe('configured target scores', () => {
  for (const targetScore of [11, 15, 21] as const) {
    it(`ends a regulation game at ${targetScore} with a two-point margin`, () => {
      const config: ScoringConfig = {
        mode: 'RALLY',
        targetScore,
        winByTwo: true,
        pointCap: null,
        bestOf: 1,
      };
      expect(isGameWon(targetScore - 1, 0, config)).toBe(false);
      expect(isGameWon(targetScore, targetScore - 2, config)).toBe(true);
      expect(gameWinner({ a: targetScore, b: targetScore - 2 }, config)).toBe('A');
      expect(isGameWon(targetScore, targetScore - 1, config)).toBe(false);
    });
  }
});

describe('capped scoring boundaries', () => {
  it('never declares a tied score a winner, even at the point cap', () => {
    expect(isGameWon(15, 15, CAPPED)).toBe(false);
    expect(gameWinner({ a: 15, b: 15 }, CAPPED)).toBeNull();
  });

  it('rejects a tied corrected game at the point cap', () => {
    expect(() => validateCorrectedGames([{ a: 15, b: 15 }], CAPPED)).toThrowError(/valid winner/);
  });

  it('accepts a legitimate capped game without a two-point margin', () => {
    expect(isGameWon(15, 14, CAPPED)).toBe(true);
    expect(gameWinner({ a: 15, b: 14 }, CAPPED)).toBe('A');
    expect(() => validateCorrectedGames([{ a: 15, b: 14 }], CAPPED)).not.toThrow();
  });
});
