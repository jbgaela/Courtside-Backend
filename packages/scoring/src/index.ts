import type { ScoreTeam, ScoringConfig } from '@picklequeue/contracts';

export interface GameScore {
  a: number;
  b: number;
}

export type ScoringStatus = 'IN_PROGRESS' | 'AWAITING_COMPLETION' | 'COMPLETED';

export interface ScoreState {
  config: ScoringConfig;
  status: ScoringStatus;
  /** Every game in order; the last entry is the current game. */
  games: GameScore[];
  gamesWonA: number;
  gamesWonB: number;
  servingTeam: ScoreTeam | null;
  winnerTeam: ScoreTeam | null;
}

export interface PointOutcome {
  state: ScoreState;
  gameWon: boolean;
  matchDecided: boolean;
  winnerTeam: ScoreTeam | null;
}

export interface MatchResult {
  winnerTeam: ScoreTeam;
  gamesWonA: number;
  gamesWonB: number;
  games: GameScore[];
}

export class ScoringError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INVALID_CONFIG'
      | 'MATCH_NOT_IN_PROGRESS'
      | 'INVALID_TEAM'
      | 'INVALID_SCORE'
      | 'MATCH_NOT_COMPLETE',
  ) {
    super(message);
    this.name = 'ScoringError';
  }
}

export function validateScoringConfig(config: ScoringConfig): void {
  if (config.mode !== 'RALLY') {
    throw new ScoringError('Only rally scoring is supported in this release', 'INVALID_CONFIG');
  }
  if (!Number.isInteger(config.targetScore) || config.targetScore < 1) {
    throw new ScoringError('Target score must be a positive integer', 'INVALID_CONFIG');
  }
  if (config.bestOf !== 1 && config.bestOf !== 3) {
    throw new ScoringError('Best-of must be 1 or 3', 'INVALID_CONFIG');
  }
  if (config.pointCap !== null) {
    if (config.pointCap < config.targetScore) {
      throw new ScoringError('Point cap cannot be below the target score', 'INVALID_CONFIG');
    }
    if (config.winByTwo && config.pointCap - config.targetScore > 10) {
      throw new ScoringError('Point cap is unreasonably high for win-by-two', 'INVALID_CONFIG');
    }
  }
}

export function gamesToWin(config: ScoringConfig): number {
  return Math.floor(config.bestOf / 2) + 1;
}

export function createInitialScoreState(
  config: ScoringConfig,
  firstServer: ScoreTeam | null = 'A',
): ScoreState {
  validateScoringConfig(config);
  return {
    config,
    status: 'IN_PROGRESS',
    games: [{ a: 0, b: 0 }],
    gamesWonA: 0,
    gamesWonB: 0,
    servingTeam: firstServer,
    winnerTeam: null,
  };
}

export function isGameWon(scoreA: number, scoreB: number, config: ScoringConfig): boolean {
  if (scoreA < 0 || scoreB < 0) return false;
  const high = Math.max(scoreA, scoreB);
  const low = Math.min(scoreA, scoreB);
  if (config.pointCap !== null && high >= config.pointCap) return true;
  if (high < config.targetScore) return false;
  if (!config.winByTwo) return true;
  return high - low >= 2;
}

export function gameWinner(score: GameScore, config: ScoringConfig): ScoreTeam | null {
  if (!isGameWon(score.a, score.b, config)) return null;
  return score.a > score.b ? 'A' : 'B';
}

export function applyPoint(state: ScoreState, team: ScoreTeam): PointOutcome {
  if (state.status !== 'IN_PROGRESS') {
    throw new ScoringError('Match is not accepting points', 'MATCH_NOT_IN_PROGRESS');
  }
  if (team !== 'A' && team !== 'B') {
    throw new ScoringError('Team must be A or B', 'INVALID_TEAM');
  }
  const games = state.games.map((game) => ({ ...game }));
  const current = games[games.length - 1];
  if (!current) throw new ScoringError('Corrupt score state', 'INVALID_SCORE');
  if (team === 'A') current.a += 1;
  else current.b += 1;

  const winner = gameWinner(current, state.config);
  if (!winner) {
    return {
      state: { ...state, games, servingTeam: team },
      gameWon: false,
      matchDecided: false,
      winnerTeam: null,
    };
  }

  const gamesWonA = state.gamesWonA + (winner === 'A' ? 1 : 0);
  const gamesWonB = state.gamesWonB + (winner === 'B' ? 1 : 0);
  const matchDecided =
    gamesWonA >= gamesToWin(state.config) || gamesWonB >= gamesToWin(state.config);

  if (matchDecided) {
    return {
      state: {
        ...state,
        games,
        gamesWonA,
        gamesWonB,
        status: 'AWAITING_COMPLETION',
        winnerTeam: gamesWonA > gamesWonB ? 'A' : 'B',
        servingTeam: winner,
      },
      gameWon: true,
      matchDecided: true,
      winnerTeam: gamesWonA > gamesWonB ? 'A' : 'B',
    };
  }

  games.push({ a: 0, b: 0 });
  return {
    state: {
      ...state,
      games,
      gamesWonA,
      gamesWonB,
      servingTeam: winner,
    },
    gameWon: true,
    matchDecided: false,
    winnerTeam: null,
  };
}

export function replayPoints(
  config: ScoringConfig,
  firstServer: ScoreTeam | null,
  points: readonly ScoreTeam[],
): ScoreState {
  let state = createInitialScoreState(config, firstServer);
  for (const team of points) {
    const outcome = applyPoint(state, team);
    state = outcome.state;
    if (state.status !== 'IN_PROGRESS') break;
  }
  return state;
}

export function finalResult(state: ScoreState): MatchResult {
  if (state.status !== 'AWAITING_COMPLETION' || !state.winnerTeam) {
    throw new ScoringError(
      'Match has not reached a winning condition',
      state.status === 'COMPLETED' ? 'MATCH_NOT_COMPLETE' : 'MATCH_NOT_COMPLETE',
    );
  }
  const required = gamesToWin(state.config);
  if (state.gamesWonA < required && state.gamesWonB < required) {
    throw new ScoringError('No team has won enough games', 'MATCH_NOT_COMPLETE');
  }
  return {
    winnerTeam: state.winnerTeam,
    gamesWonA: state.gamesWonA,
    gamesWonB: state.gamesWonB,
    games: state.games.map((game) => ({ ...game })),
  };
}

export function completedScoreState(state: ScoreState): ScoreState {
  finalResult(state);
  return { ...state, status: 'COMPLETED' };
}

export function currentGameScore(state: ScoreState): GameScore {
  return state.games[state.games.length - 1] ?? { a: 0, b: 0 };
}

export function matchPoints(state: ScoreState): { a: number; b: number } {
  return state.games.reduce((total, game) => ({ a: total.a + game.a, b: total.b + game.b }), {
    a: 0,
    b: 0,
  });
}

export function isWinningPoint(state: ScoreState, team: ScoreTeam): boolean {
  if (state.status !== 'IN_PROGRESS') return false;
  const outcome = applyPoint(state, team);
  return outcome.gameWon;
}

export function scoreSummary(state: ScoreState): string {
  const current = currentGameScore(state);
  return `${current.a}-${current.b} (games ${state.gamesWonA}-${state.gamesWonB})`;
}

/**
 * A correction is a deliberate replacement of a completed match's games.
 * Validation rejects impossible sequences (for example 11-10 with win-by-two).
 */
export function validateCorrectedGames(games: readonly GameScore[], config: ScoringConfig): void {
  validateScoringConfig(config);
  if (games.length === 0)
    throw new ScoringError('A match needs at least one game', 'INVALID_SCORE');
  if (config.bestOf === 1 && games.length !== 1) {
    throw new ScoringError('Best-of-1 matches need exactly one game', 'INVALID_SCORE');
  }
  if (games.length > config.bestOf) {
    throw new ScoringError('More games than the best-of format allows', 'INVALID_SCORE');
  }

  const required = gamesToWin(config);
  let aWins = 0;
  let bWins = 0;

  for (const [index, game] of games.entries()) {
    if (!Number.isInteger(game.a) || !Number.isInteger(game.b) || game.a < 0 || game.b < 0) {
      throw new ScoringError('Scores must be non-negative integers', 'INVALID_SCORE');
    }
    const alreadyDecided = aWins >= required || bWins >= required;
    if (alreadyDecided) {
      throw new ScoringError(
        'A correction cannot contain games after the match was decided',
        'INVALID_SCORE',
      );
    }
    const winner = gameWinner(game, config);
    if (!winner) {
      throw new ScoringError('Every corrected game needs a valid winner', 'INVALID_SCORE');
    }
    if (winner === 'A') aWins += 1;
    else bWins += 1;
  }

  if (aWins < required && bWins < required) {
    throw new ScoringError('Corrected match does not have a valid winner', 'INVALID_SCORE');
  }
}
