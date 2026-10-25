import {
  MATCHMAKING_DEFAULTS,
  type MatchmakingConfig,
  type MatchFormat,
} from '@picklequeue/contracts';
import {
  buildPairHistory,
  hashInput,
  proposeMatches,
  waitMinutes,
  type MatchmakingCourt,
  type MatchmakingPlayer,
  type ProposedMatch,
  type RecentMatch,
} from './engine.js';

export interface SimulationPlayerInput {
  userId: string;
  displayName: string;
  skill: number;
  gamesPlayed?: number;
  wins?: number;
  losses?: number;
  available?: boolean;
  paused?: boolean;
  initialWaitMinutes?: number;
}

export interface SimulationOptions {
  seed: number;
  players: SimulationPlayerInput[];
  courtCount: number;
  rounds: number;
  config?: Partial<MatchmakingConfig>;
  roundDurationMinutes?: number;
  format?: MatchFormat;
  /** Exclude the first N rounds from utilization metrics (warm-up). */
  warmupRounds?: number;
}

export interface SimulatedGame {
  matchId: string;
  round: number;
  courtId: string;
  courtName: string;
  teamAUserIds: string[];
  teamBUserIds: string[];
  winnerTeam: 'A' | 'B';
  scoreA: number;
  scoreB: number;
}

export interface SimulationPlayerResult {
  userId: string;
  displayName: string;
  skill: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  totalWaitMinutes: number;
  averageWaitMinutes: number;
  longestWaitMinutes: number;
}

export interface SimulationReport {
  seed: number;
  rounds: number;
  format: MatchFormat;
  perPlayer: SimulationPlayerResult[];
  maxPlayDisparity: number;
  averageGamesPlayed: number;
  averageWaitMinutes: number;
  p95WaitMinutes: number;
  maxWaitMinutes: number;
  repeatedPartnerships: number;
  courtUtilization: number;
  starvationIncidents: number;
  longWaitIncidents: number;
  games: SimulatedGame[];
  warnings: string[];
  inputHashes: string[];
}

const WINNING_SCORES = [11, 12, 13, 14, 15] as const;

/** Small deterministic PRNG (mulberry32). */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function runSimulation(options: SimulationOptions): SimulationReport {
  const config: MatchmakingConfig = {
    ...MATCHMAKING_DEFAULTS,
    ...options.config,
    strategy: options.config?.strategy ?? 'HYBRID',
  };
  if (options.format) config.format = options.format;

  const roundDuration = (options.roundDurationMinutes ?? 12) * 60_000;
  const restMs = config.minRestMinutes * 60_000;
  const rng = createRng(options.seed);
  const warmup = options.warmupRounds ?? 0;

  const state = new Map<string, MatchmakingPlayer>();
  const waitTotals = new Map<string, number>();
  const waitSamples: number[] = [];
  const longestWait = new Map<string, number>();

  for (const [index, input] of options.players.entries()) {
    const waitingSince = -((input.initialWaitMinutes ?? 0) * 60_000);
    state.set(input.userId, {
      id: `sim-${index + 1}`,
      userId: input.userId,
      displayName: input.displayName,
      skill: input.skill,
      gamesPlayed: input.gamesPlayed ?? 0,
      waitingSince,
      checkedIn: input.available ?? true,
      paused: input.paused ?? false,
      left: false,
      restUntil: null,
      currentAssignmentId: null,
      wins: input.wins ?? 0,
      losses: input.losses ?? 0,
    });
    waitTotals.set(input.userId, 0);
    longestWait.set(input.userId, 0);
  }

  const courts: MatchmakingCourt[] = Array.from({ length: options.courtCount }, (_, index) => ({
    id: `sim-court-${index + 1}`,
    name: `Court ${index + 1}`,
  }));

  const games: SimulatedGame[] = [];
  const recentMatches: RecentMatch[] = [];
  const warnings = new Set<string>();
  const inputHashes: string[] = [];
  let assignmentSlots = 0;
  let longWaitIncidents = 0;

  for (let round = 1; round <= options.rounds; round += 1) {
    const now = (round - 1) * roundDuration;
    const players = [...state.values()].map((player) => ({ ...player }));
    const input = {
      now,
      config,
      players,
      courts,
      recentMatches,
    };
    const result = proposeMatches(input);
    inputHashes.push(hashInput(input));

    for (const warning of result.warnings) warnings.add(warning);
    if (round > warmup) assignmentSlots += result.assignments.length;

    for (const player of players) {
      if (!player.checkedIn || player.paused || player.left) continue;
      const wait = waitMinutes(player, now);
      if (wait >= 24) longWaitIncidents += 1;
      waitSamples.push(wait);
      waitTotals.set(player.userId, (waitTotals.get(player.userId) ?? 0) + wait);
      longestWait.set(player.userId, Math.max(longestWait.get(player.userId) ?? 0, wait));
    }

    for (const [courtIndex, assignment] of result.assignments.entries()) {
      const winnerTeam: 'A' | 'B' = rng() < 0.5 ? 'A' : 'B';
      const loserScore = Math.floor(rng() * 8);
      const winnerScore = WINNING_SCORES[Math.floor(rng() * WINNING_SCORES.length)] ?? 11;
      const scoreA = winnerTeam === 'A' ? winnerScore : loserScore;
      const scoreB = winnerTeam === 'B' ? winnerScore : loserScore;
      const match: SimulatedGame = {
        matchId: `sim-match-${round}-${courtIndex + 1}`,
        round,
        courtId: assignment.courtId,
        courtName: assignment.courtName,
        teamAUserIds: assignment.teamA.map((player) => player.userId),
        teamBUserIds: assignment.teamB.map((player) => player.userId),
        winnerTeam,
        scoreA,
        scoreB,
      };
      games.push(match);
      recentMatches.push({
        id: match.matchId,
        round,
        completedAt: now + 5 * 60_000,
        teamAUserIds: match.teamAUserIds,
        teamBUserIds: match.teamBUserIds,
      });

      const all = [...match.teamAUserIds, ...match.teamBUserIds];
      for (const userId of all) {
        const player = state.get(userId);
        if (!player) continue;
        player.gamesPlayed += 1;
        if ((winnerTeam === 'A') === match.teamAUserIds.includes(userId)) player.wins += 1;
        else player.losses += 1;
        const nextNow = now + 5 * 60_000 + restMs;
        player.waitingSince = nextNow;
        player.restUntil = now + 5 * 60_000 + restMs;
      }
    }

    // Unassigned players keep accruing wait from their existing timestamp.
    for (const player of state.values()) {
      if (player.paused || !player.checkedIn || player.left) continue;
      if (player.restUntil !== null && player.restUntil <= now + roundDuration) {
        player.restUntil = null;
      }
    }
  }

  const perPlayer: SimulationPlayerResult[] = options.players.map((input) => {
    const player = state.get(input.userId);
    const elapsedRounds = Math.max(1, options.rounds);
    const totalWait = waitTotals.get(input.userId) ?? 0;
    return {
      userId: input.userId,
      displayName: input.displayName,
      skill: input.skill,
      gamesPlayed: player?.gamesPlayed ?? 0,
      wins: player?.wins ?? 0,
      losses: player?.losses ?? 0,
      totalWaitMinutes: round1(totalWait),
      averageWaitMinutes: round1(totalWait / elapsedRounds),
      longestWaitMinutes: round1(longestWait.get(input.userId) ?? 0),
    };
  });

  const playCounts = perPlayer.map((player) => player.gamesPlayed);
  const maxPlay = playCounts.length > 0 ? Math.max(...playCounts) : 0;
  const minPlay = playCounts.length > 0 ? Math.min(...playCounts) : 0;
  const effectiveSamples = waitSamples.length > 0 ? waitSamples : [0];
  const sortedWaits = [...effectiveSamples].sort((a, b) => a - b);
  const p95Index = Math.min(sortedWaits.length - 1, Math.ceil(sortedWaits.length * 0.95) - 1);

  const partnershipCounts = new Map<string, number>();
  for (const game of games) {
    countPairs(game.teamAUserIds, partnershipCounts);
    countPairs(game.teamBUserIds, partnershipCounts);
  }
  const repeatedPartnerships = [...partnershipCounts.values()].filter((count) => count > 1).length;

  const countedRounds = Math.max(1, options.rounds - warmup);
  const courtUtilization = assignmentSlots / (countedRounds * Math.max(1, options.courtCount));
  const starvationIncidents = perPlayer.filter(
    (player) => maxPlay - player.gamesPlayed > Math.max(2, config.starvationMaxGap + 1),
  ).length;

  return {
    seed: options.seed,
    rounds: options.rounds,
    format: config.format,
    perPlayer,
    maxPlayDisparity: maxPlay - minPlay,
    averageGamesPlayed: round2(
      playCounts.length > 0
        ? playCounts.reduce((sum, value) => sum + value, 0) / playCounts.length
        : 0,
    ),
    averageWaitMinutes: round1(
      effectiveSamples.reduce((sum, value) => sum + value, 0) / effectiveSamples.length,
    ),
    p95WaitMinutes: round1(sortedWaits[p95Index] ?? 0),
    maxWaitMinutes: round1(Math.max(...effectiveSamples)),
    repeatedPartnerships,
    courtUtilization: round2(courtUtilization),
    starvationIncidents,
    longWaitIncidents,
    games,
    warnings: [...warnings],
    inputHashes,
  };
}

function countPairs(userIds: string[], counts: Map<string, number>): void {
  for (let i = 0; i < userIds.length; i += 1) {
    for (let j = i + 1; j < userIds.length; j += 1) {
      const pair = [userIds[i]!, userIds[j]!].sort().join('|');
      counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function summarizeAssignment(assignment: ProposedMatch): string {
  const a = assignment.teamA.map((player) => player.displayName).join(' + ');
  const b = assignment.teamB.map((player) => player.displayName).join(' + ');
  return `${assignment.courtName}: ${a} (${assignment.teamRatingA}) vs ${b} (${assignment.teamRatingB})`;
}

export { buildPairHistory };
