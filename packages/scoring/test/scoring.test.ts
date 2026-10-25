import { describe, expect, it } from 'vitest';
import type { ScoringConfig } from '@picklequeue/contracts';
import {
  ScoringError,
  applyPoint,
  completedScoreState,
  createInitialScoreState,
  currentGameScore,
  finalResult,
  gameWinner,
  gamesToWin,
  isGameWon,
  matchPoints,
  replayPoints,
  validateCorrectedGames,
} from '../src/index.js';

const BASE: ScoringConfig = {
  mode: 'RALLY',
  targetScore: 11,
  winByTwo: true,
  pointCap: null,
  bestOf: 1,
};

function score(state: ReturnType<typeof createInitialScoreState>, team: 'A' | 'B', points: number) {
  let current = state;
  for (let index = 0; index < points; index += 1) {
    current = applyPoint(current, team).state;
  }
  return current;
}

describe('rally scoring', () => {
  it('creates a valid initial state', () => {
    const state = createInitialScoreState(BASE);
    expect(state.games).toEqual([{ a: 0, b: 0 }]);
    expect(state.status).toBe('IN_PROGRESS');
    expect(gamesToWin(BASE)).toBe(1);
  });

  it('awards a game at the target and requires completion', () => {
    let state = score(createInitialScoreState(BASE), 'A', 10);
    expect(state.status).toBe('IN_PROGRESS');
    const outcome = applyPoint(state, 'A');
    expect(outcome.gameWon).toBe(true);
    expect(outcome.matchDecided).toBe(true);
    state = outcome.state;
    expect(state.status).toBe('AWAITING_COMPLETION');
    expect(state.winnerTeam).toBe('A');
    expect(currentGameScore(state)).toEqual({ a: 11, b: 0 });
    expect(() => applyPoint(state, 'B')).toThrowError(ScoringError);
    expect(finalResult(state).winnerTeam).toBe('A');
  });

  it('enforces win-by-two', () => {
    let state = score(createInitialScoreState(BASE), 'A', 10);
    state = score(state, 'B', 10);
    state = score(state, 'A', 1);
    expect(state.status).toBe('IN_PROGRESS');
    expect(currentGameScore(state)).toEqual({ a: 11, b: 10 });
    state = score(state, 'B', 1);
    expect(currentGameScore(state)).toEqual({ a: 11, b: 11 });
    state = score(state, 'A', 2);
    expect(state.status).toBe('AWAITING_COMPLETION');
    expect(currentGameScore(state)).toEqual({ a: 13, b: 11 });
  });

  it('supports win-by-one when configured', () => {
    const config: ScoringConfig = { ...BASE, winByTwo: false };
    let state = score(createInitialScoreState(config), 'A', 10);
    state = score(state, 'B', 10);
    state = score(state, 'A', 1);
    expect(state.status).toBe('AWAITING_COMPLETION');
    expect(currentGameScore(state)).toEqual({ a: 11, b: 10 });
  });

  it('ends at the point cap even without a two-point margin', () => {
    const config: ScoringConfig = { ...BASE, pointCap: 11, winByTwo: true };
    let state = score(createInitialScoreState(config), 'A', 10);
    state = score(state, 'B', 10);
    state = score(state, 'A', 1);
    expect(state.status).toBe('AWAITING_COMPLETION');
    expect(currentGameScore(state)).toEqual({ a: 11, b: 10 });
  });

  it('does not treat 10-0 as a win', () => {
    expect(isGameWon(10, 0, BASE)).toBe(false);
    expect(gameWinner({ a: 10, b: 0 }, BASE)).toBeNull();
  });

  it('plays best-of-three with a new game after a game win', () => {
    const config: ScoringConfig = { ...BASE, bestOf: 3 };
    let state = score(createInitialScoreState(config), 'A', 11);
    expect(state.status).toBe('IN_PROGRESS');
    expect(state.games).toHaveLength(2);
    expect(state.gamesWonA).toBe(1);
    expect(currentGameScore(state)).toEqual({ a: 0, b: 0 });
    state = score(state, 'A', 11);
    expect(state.status).toBe('AWAITING_COMPLETION');
    expect(state.gamesWonA).toBe(2);
    const result = finalResult(state);
    expect(result.gamesWonA).toBe(2);
    expect(result.games).toHaveLength(2);
  });

  it('goes to a third game at 1-1', () => {
    const config: ScoringConfig = { ...BASE, bestOf: 3 };
    let state = score(createInitialScoreState(config), 'A', 11);
    state = score(state, 'B', 11);
    expect(state.games).toHaveLength(3);
    expect(state.gamesWonA).toBe(1);
    expect(state.gamesWonB).toBe(1);
    state = score(state, 'B', 11);
    expect(state.status).toBe('AWAITING_COMPLETION');
    expect(finalResult(state).winnerTeam).toBe('B');
  });

  it('replays events deterministically', () => {
    const events = ['A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A'] as const;
    const state = replayPoints(BASE, 'A', events);
    expect(state.status).toBe('AWAITING_COMPLETION');
    expect(currentGameScore(state)).toEqual({ a: 11, b: 0 });
    expect(scoreSummarySafe(state)).toBe('11-0 (games 1-0)');
  });

  it('counts total points', () => {
    const config: ScoringConfig = { ...BASE, bestOf: 3 };
    let state = score(createInitialScoreState(config), 'A', 11);
    state = score(state, 'B', 11);
    expect(matchPoints(state)).toEqual({ a: 11, b: 11 });
  });

  it('completes a state only after a valid win', () => {
    const state = score(createInitialScoreState(BASE), 'A', 5);
    expect(() => completedScoreState(state)).toThrowError(ScoringError);
  });
});

describe('corrected scores', () => {
  it('accepts a best-of-three 2-0 correction', () => {
    expect(() =>
      validateCorrectedGames(
        [
          { a: 11, b: 5 },
          { a: 11, b: 9 },
        ],
        { ...BASE, bestOf: 3 },
      ),
    ).not.toThrow();
  });

  it('accepts a best-of-three 2-1 correction', () => {
    expect(() =>
      validateCorrectedGames(
        [
          { a: 11, b: 5 },
          { a: 9, b: 11 },
          { a: 11, b: 7 },
        ],
        { ...BASE, bestOf: 3 },
      ),
    ).not.toThrow();
  });

  it('rejects an invalid 11-10 win-by-two score', () => {
    expect(() => validateCorrectedGames([{ a: 11, b: 10 }], BASE)).toThrowError(/valid winner/);
  });

  it('rejects games after a match is already decided', () => {
    expect(() =>
      validateCorrectedGames(
        [
          { a: 11, b: 5 },
          { a: 11, b: 6 },
          { a: 11, b: 7 },
        ],
        { ...BASE, bestOf: 3 },
      ),
    ).toThrowError(/after the match was decided/);
  });

  it('rejects multiple games in a best-of-one', () => {
    expect(() =>
      validateCorrectedGames(
        [
          { a: 11, b: 5 },
          { a: 11, b: 6 },
        ],
        BASE,
      ),
    ).toThrowError(/exactly one game/);
  });
});

function scoreSummarySafe(state: ReturnType<typeof createInitialScoreState>): string {
  const current = currentGameScore(state);
  return `${current.a}-${current.b} (games ${state.gamesWonA}-${state.gamesWonB})`;
}
