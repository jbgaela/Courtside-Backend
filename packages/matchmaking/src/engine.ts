import type { MatchFormat, MatchmakingConfig, MatchmakingStrategy } from '@picklequeue/contracts';

export interface MatchmakingPlayer {
  /** Queue-entry identifier; unique per session. */
  id: string;
  userId: string;
  displayName: string;
  skill: number;
  gamesPlayed: number;
  /** Epoch milliseconds when the player's current eligible wait began. */
  waitingSince: number;
  checkedIn: boolean;
  paused: boolean;
  left: boolean;
  restUntil: number | null;
  currentAssignmentId: string | null;
  wins: number;
  losses: number;
}

export interface RecentMatch {
  id: string;
  round: number;
  completedAt: number;
  teamAUserIds: string[];
  teamBUserIds: string[];
}

export interface MatchmakingCourt {
  id: string;
  name: string;
}

export interface MatchmakingInput {
  now: number;
  config: MatchmakingConfig;
  players: MatchmakingPlayer[];
  courts: MatchmakingCourt[];
  recentMatches?: RecentMatch[];
  /** Optional cap for callers that only want part of the free courts. */
  maxAssignments?: number;
  strategy?: MatchmakingStrategy;
}

export interface SelectedPlayer {
  queueEntryId: string;
  userId: string;
  displayName: string;
  skill: number;
  gamesPlayed: number;
  waitMinutes: number;
}

export interface ProposedMatch {
  courtId: string;
  courtName: string;
  teamA: SelectedPlayer[];
  teamB: SelectedPlayer[];
  teamRatingA: number;
  teamRatingB: number;
  teamBalance: number;
  skillSpread: number;
  cost: number;
  reasons: string[];
  warnings: string[];
}

export interface BenchedPlayer {
  queueEntryId: string;
  userId: string;
  displayName: string;
  gamesPlayed: number;
  waitMinutes: number;
  reason: string;
}

export interface MatchmakingMetrics {
  eligiblePlayers: number;
  availableCourts: number;
  assignedPlayers: number;
  averageWaitMinutes: number;
  maxWaitMinutes: number;
  averageTeamBalance: number;
  averageSkillSpread: number;
  repeatedPartnerships: number;
}

export interface MatchmakingResult {
  format: MatchFormat;
  assignments: ProposedMatch[];
  bench: BenchedPlayer[];
  warnings: string[];
  metrics: MatchmakingMetrics;
  /** Stable signature of the input snapshot, useful for stale-preview checks. */
  inputHash: string;
}

export interface PairHistory {
  partners: number;
  opponents: number;
}

export type PairHistoryIndex = Map<string, PairHistory>;

const GAMES_WEIGHT = 1_000_000;
const WAIT_BONUS_PER_SECOND = 18;
const MAX_WAIT_BONUS_SECONDS = 3600;
const REPEAT_COST_SCALE = 20;
const MAX_CANDIDATES = 24;
const BALANCE_WEIGHT = 900;

const STRATEGY_WEIGHTS: Record<
  MatchmakingStrategy,
  { skill: number; balance: number; repeat: number }
> = {
  HYBRID: { skill: 600, balance: BALANCE_WEIGHT, repeat: 20 },
  SKILL_FIRST: { skill: 1400, balance: 1100, repeat: 12 },
  FAIRNESS_FIRST: { skill: 260, balance: 500, repeat: 32 },
};

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function buildPairHistory(
  matches: RecentMatch[],
  partnerPenalty: number,
  opponentPenalty: number,
): PairHistoryIndex {
  const index: PairHistoryIndex = new Map();
  const ordered = [...matches].sort((a, b) => b.completedAt - a.completedAt).slice(0, 20);

  const add = (a: string, b: string, kind: 'partners' | 'opponents', weight: number) => {
    const key = pairKey(a, b);
    const current = index.get(key) ?? { partners: 0, opponents: 0 };
    if (kind === 'partners') {
      current.partners += partnerPenalty * weight;
    } else {
      current.opponents += opponentPenalty * weight;
    }
    index.set(key, current);
  };

  for (const [position, match] of ordered.entries()) {
    const weight = 1 / (1 + position * 0.6);
    const teamA = match.teamAUserIds;
    const teamB = match.teamBUserIds;
    for (let i = 0; i < teamA.length; i += 1) {
      for (let j = i + 1; j < teamA.length; j += 1) {
        add(teamA[i]!, teamA[j]!, 'partners', weight);
      }
    }
    for (let i = 0; i < teamB.length; i += 1) {
      for (let j = i + 1; j < teamB.length; j += 1) {
        add(teamB[i]!, teamB[j]!, 'partners', weight);
      }
    }
    for (const a of teamA) {
      for (const b of teamB) {
        add(a, b, 'opponents', weight);
      }
    }
  }
  return index;
}

export function isEligible(
  player: MatchmakingPlayer,
  now: number,
  config: MatchmakingConfig,
): boolean {
  if (!player.checkedIn || player.paused || player.left) return false;
  if (player.currentAssignmentId) return false;
  if (player.restUntil !== null && player.restUntil > now) return false;
  if (config.maxGamesPerPlayer !== null && player.gamesPlayed >= config.maxGamesPerPlayer) {
    return false;
  }
  return true;
}

export function waitMinutes(player: MatchmakingPlayer, now: number): number {
  return Math.max(0, (now - player.waitingSince) / 60_000);
}

export function computeTeamRole(assignment: ProposedMatch): 'A' | 'B' {
  return assignment.teamRatingA <= assignment.teamRatingB ? 'A' : 'B';
}

export function proposeMatches(input: MatchmakingInput): MatchmakingResult {
  const { now, config } = input;
  const strategy = input.strategy ?? config.strategy;
  const weights = STRATEGY_WEIGHTS[strategy];
  const format: MatchFormat = config.format;
  const teamSize = format === 'DOUBLES' ? 2 : 1;
  const playersPerMatch = teamSize * 2;
  const history = buildPairHistory(
    input.recentMatches ?? [],
    config.partnerPenalty,
    config.opponentPenalty,
  );

  const eligible = input.players
    .filter((player) => isEligible(player, now, config))
    .sort(comparePlayers(now));

  const minGames = eligible.length > 0 ? Math.min(...eligible.map((p) => p.gamesPlayed)) : 0;
  let fairnessPool = eligible.filter(
    (player) => player.gamesPlayed <= minGames + config.starvationMaxGap,
  );

  const globalWarnings = new Set<string>();
  if (fairnessPool.length < playersPerMatch && eligible.length >= playersPerMatch) {
    fairnessPool = eligible;
    globalWarnings.add(
      'Fairness pool was too small for a match; the games-played gap was widened to keep play moving.',
    );
  }

  const remaining = new Map(fairnessPool.map((player) => [player.userId, player]));
  const courts = [...input.courts].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const maxAssignments = Math.max(
    0,
    Math.min(courts.length, input.maxAssignments ?? courts.length),
  );

  const assignments: ProposedMatch[] = [];

  for (const court of courts) {
    if (assignments.length >= maxAssignments) break;
    if (remaining.size < playersPerMatch) break;

    const pool = [...remaining.values()].sort(comparePlayers(now));
    const anchor = pool[0];
    if (!anchor) break;

    const anchorWait = waitMinutes(anchor, now);
    const effectiveMaxSpread = widenedSpread(config, anchorWait, strategy);
    const preferredCandidates = buildCandidatePool(pool, anchor, config, now);

    let best: { match: InternalMatch; warning?: string } | null = null;

    best = searchCombinations(
      preferredCandidates,
      anchor,
      teamSize,
      effectiveMaxSpread,
      config,
      now,
      history,
      weights,
    );

    if (!best) {
      best = searchCombinations(
        pool,
        anchor,
        teamSize,
        config.maxSkillSpread,
        config,
        now,
        history,
        weights,
      );
      if (best) {
        globalWarnings.add('Skill range widened to the maximum to avoid a long wait.');
      }
    }

    if (!best && config.allowMixedSkillFallback) {
      best = searchCombinations(
        pool,
        anchor,
        teamSize,
        Number.POSITIVE_INFINITY,
        config,
        now,
        history,
        weights,
      );
      if (best) {
        const warning = 'Mixed-skill fallback used: no group met the configured skill spread.';
        best.warning = warning;
        globalWarnings.add(warning);
      }
    }

    if (!best) break;

    const selectedIds = new Set(
      [...best.match.teamA, ...best.match.teamB].map((player) => player.userId),
    );
    for (const userId of selectedIds) remaining.delete(userId);

    assignments.push(toProposedMatch(court, best.match, anchor, now, best.warning));
  }

  const assignedIds = new Set(
    assignments.flatMap((assignment) =>
      [...assignment.teamA, ...assignment.teamB].map((player) => player.userId),
    ),
  );

  const bench: BenchedPlayer[] = input.players
    .filter((player) => !assignedIds.has(player.userId))
    .map((player) => {
      const reason = !player.checkedIn
        ? 'Not checked in'
        : player.left
          ? 'Left the session'
          : player.paused
            ? 'Paused'
            : player.currentAssignmentId
              ? 'Already assigned'
              : player.restUntil !== null && player.restUntil > now
                ? 'Resting'
                : config.maxGamesPerPlayer !== null &&
                    player.gamesPlayed >= config.maxGamesPerPlayer
                  ? 'Reached game cap'
                  : player.gamesPlayed > minGames + config.starvationMaxGap
                    ? 'Fairness guard: more games played than the waiting pool'
                    : 'Waiting for the next rotation';
      return {
        queueEntryId: player.id,
        userId: player.userId,
        displayName: player.displayName,
        gamesPlayed: player.gamesPlayed,
        waitMinutes: Math.round(waitMinutes(player, now) * 10) / 10,
        reason,
      };
    })
    .sort((a, b) => b.waitMinutes - a.waitMinutes);

  const waits = eligible.map((player) => waitMinutes(player, now));
  const averageWait =
    waits.length > 0 ? waits.reduce((sum, value) => sum + value, 0) / waits.length : 0;
  const repeatCount = assignments.reduce((count, assignment) => {
    return count + countRepeatedPairs(assignment, history);
  }, 0);

  return {
    format,
    assignments,
    bench,
    warnings: [...globalWarnings],
    metrics: {
      eligiblePlayers: eligible.length,
      availableCourts: courts.length,
      assignedPlayers: assignedIds.size,
      averageWaitMinutes: round1(averageWait),
      maxWaitMinutes: round1(waits.length > 0 ? Math.max(...waits) : 0),
      averageTeamBalance:
        assignments.length > 0
          ? round2(
              assignments.reduce((sum, assignment) => sum + assignment.teamBalance, 0) /
                assignments.length,
            )
          : 0,
      averageSkillSpread:
        assignments.length > 0
          ? round2(
              assignments.reduce((sum, assignment) => sum + assignment.skillSpread, 0) /
                assignments.length,
            )
          : 0,
      repeatedPartnerships: repeatCount,
    },
    inputHash: hashInput(input),
  };
}

interface InternalMatch {
  teamA: MatchmakingPlayer[];
  teamB: MatchmakingPlayer[];
  cost: number;
  teamRatingA: number;
  teamRatingB: number;
  balance: number;
  spread: number;
  repeatCount: number;
}

interface Weights {
  skill: number;
  balance: number;
  repeat: number;
}

function comparePlayers(now: number) {
  return (a: MatchmakingPlayer, b: MatchmakingPlayer): number => {
    if (a.gamesPlayed !== b.gamesPlayed) return a.gamesPlayed - b.gamesPlayed;
    const waitA = waitMinutes(a, now);
    const waitB = waitMinutes(b, now);
    if (waitB !== waitA) return waitB - waitA;
    if (a.skill !== b.skill) return a.skill - b.skill;
    return a.id.localeCompare(b.id);
  };
}

function widenedSpread(
  config: MatchmakingConfig,
  anchorWait: number,
  strategy: MatchmakingStrategy,
): number {
  if (strategy === 'SKILL_FIRST') return config.preferredSkillSpread;
  if (config.widenAfterMinutes <= 0) return config.maxSkillSpread;
  const progress = Math.min(1, anchorWait / config.widenAfterMinutes);
  return (
    config.preferredSkillSpread + (config.maxSkillSpread - config.preferredSkillSpread) * progress
  );
}

function buildCandidatePool(
  pool: MatchmakingPlayer[],
  anchor: MatchmakingPlayer,
  config: MatchmakingConfig,
  now: number,
): MatchmakingPlayer[] {
  const byFairness = pool.slice(0, 16);
  const bySkill = [...pool]
    .sort((a, b) => {
      const distance = Math.abs(a.skill - anchor.skill) - Math.abs(b.skill - anchor.skill);
      if (distance !== 0) return distance;
      return comparePlayers(now)(a, b);
    })
    .slice(0, 8);
  const seen = new Set<string>();
  const merged: MatchmakingPlayer[] = [];
  for (const player of [...byFairness, ...bySkill]) {
    if (seen.has(player.userId)) continue;
    seen.add(player.userId);
    merged.push(player);
  }
  // Anchor must always participate in the candidate search.
  if (!seen.has(anchor.userId)) merged.unshift(anchor);
  return merged.slice(0, MAX_CANDIDATES);
}

function searchCombinations(
  pool: MatchmakingPlayer[],
  anchor: MatchmakingPlayer,
  teamSize: number,
  maxSpread: number,
  config: MatchmakingConfig,
  now: number,
  history: PairHistoryIndex,
  weights: Weights,
): { match: InternalMatch } | null {
  if (teamSize === 1) {
    let best: InternalMatch | null = null;
    const opponents = pool.filter((player) => player.userId !== anchor.userId);
    for (const opponent of opponents) {
      const spread = Math.abs(anchor.skill - opponent.skill);
      if (spread > maxSpread) continue;
      const match = scoreTeams([anchor], [opponent], spread, history, now, weights);
      if (!best || match.cost < best.cost) best = match;
    }
    return best ? { match: best } : null;
  }

  const candidates = pool.filter((player) => player.userId !== anchor.userId);
  if (candidates.length < 3) return null;

  let best: InternalMatch | null = null;
  let bestKey = '';

  for (let i = 0; i < candidates.length - 2; i += 1) {
    for (let j = i + 1; j < candidates.length - 1; j += 1) {
      for (let k = j + 1; k < candidates.length; k += 1) {
        const group = [anchor, candidates[i]!, candidates[j]!, candidates[k]!];
        const spread = groupSpread(group);
        if (spread > maxSpread + 1e-9) continue;
        const match = evaluateDoublesGroup(group, spread, history, now, weights);
        const key = group
          .map((player) => player.id)
          .sort()
          .join('|');
        if (
          !best ||
          match.cost < best.cost - 1e-9 ||
          (Math.abs(match.cost - best.cost) < 1e-9 && key < bestKey)
        ) {
          best = match;
          bestKey = key;
        }
      }
    }
  }

  return best ? { match: best } : null;
}

function groupSpread(group: MatchmakingPlayer[]): number {
  const skills = group.map((player) => player.skill);
  return Math.max(...skills) - Math.min(...skills);
}

function evaluateDoublesGroup(
  group: MatchmakingPlayer[],
  spread: number,
  history: PairHistoryIndex,
  now: number,
  weights: Weights,
): InternalMatch {
  let best: InternalMatch | null = null;
  for (const [teamA, teamB] of buildPartitions(group)) {
    const candidate = scoreTeams(teamA, teamB, spread, history, now, weights);
    if (!best || candidate.cost < best.cost) best = candidate;
  }
  if (!best) {
    throw new Error('Doubles groups require exactly four players');
  }
  return best;
}

function scoreTeams(
  teamAInput: MatchmakingPlayer[],
  teamBInput: MatchmakingPlayer[],
  spread: number,
  history: PairHistoryIndex,
  now: number,
  weights: Weights,
): InternalMatch {
  const players = [...teamAInput, ...teamBInput];
  const ratingA = sumSkill(teamAInput);
  const ratingB = sumSkill(teamBInput);
  const balance = Math.abs(ratingA - ratingB);
  const repeats = repeatCost(teamAInput, teamBInput, history, weights);
  const fairness = players.reduce((sum, player) => {
    const wait = Math.min(waitMinutes(player, now) * 60, MAX_WAIT_BONUS_SECONDS);
    return sum + player.gamesPlayed * GAMES_WEIGHT - wait * WAIT_BONUS_PER_SECOND;
  }, 0);
  const cost = fairness + spread * weights.skill + balance * weights.balance + repeats;
  return {
    teamA: [...teamAInput],
    teamB: [...teamBInput],
    cost,
    teamRatingA: round2(ratingA),
    teamRatingB: round2(ratingB),
    balance: round2(balance),
    spread: round2(spread),
    repeatCount: repeats > 0 ? 1 : 0,
  };
}

function buildPartitions(
  players: MatchmakingPlayer[],
): Array<readonly [MatchmakingPlayer[], MatchmakingPlayer[]]> {
  const [a, b, c, d] = players;
  if (!a || !b || !c || !d) return [];
  return [
    [
      [a, b],
      [c, d],
    ],
    [
      [a, c],
      [b, d],
    ],
    [
      [a, d],
      [b, c],
    ],
  ];
}

function repeatCost(
  teamA: MatchmakingPlayer[],
  teamB: MatchmakingPlayer[],
  history: PairHistoryIndex,
  weights: Weights,
): number {
  let cost = 0;
  const addWithin = (team: MatchmakingPlayer[]) => {
    for (let i = 0; i < team.length; i += 1) {
      for (let j = i + 1; j < team.length; j += 1) {
        const record = history.get(pairKey(team[i]!.userId, team[j]!.userId));
        if (record) cost += record.partners * weights.repeat;
      }
    }
  };
  addWithin(teamA);
  addWithin(teamB);
  for (const playerA of teamA) {
    for (const playerB of teamB) {
      const record = history.get(pairKey(playerA.userId, playerB.userId));
      if (record) cost += record.opponents * weights.repeat;
    }
  }
  return cost;
}

function countRepeatedPairs(assignment: ProposedMatch, history: PairHistoryIndex): number {
  let count = 0;
  const check = (a: string, b: string) => {
    const record = history.get(pairKey(a, b));
    if (record && (record.partners > 0 || record.opponents > 0)) count += 1;
  };
  const teamA = assignment.teamA;
  const teamB = assignment.teamB;
  for (let i = 0; i < teamA.length; i += 1) {
    for (let j = i + 1; j < teamA.length; j += 1) check(teamA[i]!.userId, teamA[j]!.userId);
  }
  for (let i = 0; i < teamB.length; i += 1) {
    for (let j = i + 1; j < teamB.length; j += 1) check(teamB[i]!.userId, teamB[j]!.userId);
  }
  return count;
}

function toProposedMatch(
  court: MatchmakingCourt,
  match: InternalMatch,
  anchor: MatchmakingPlayer,
  now: number,
  warning?: string,
): ProposedMatch {
  const teamA = match.teamA.map((player) => selectPlayer(player, now));
  const teamB = match.teamB.map((player) => selectPlayer(player, now));
  const reasons: string[] = [];
  if (
    anchor.gamesPlayed === Math.min(...[...match.teamA, ...match.teamB].map((p) => p.gamesPlayed))
  ) {
    reasons.push(`Fewest games played (${anchor.gamesPlayed})`);
  }
  const wait = Math.round(waitMinutes(anchor, now));
  if (wait > 0) reasons.push(`Longest current wait (${wait} min)`);
  reasons.push(`Team rating ${match.teamRatingA.toFixed(2)} vs ${match.teamRatingB.toFixed(2)}`);
  reasons.push(`Skill spread ${match.spread.toFixed(2)}`);
  if (match.repeatCount === 0) reasons.push('No recent repeat pairings');

  return {
    courtId: court.id,
    courtName: court.name,
    teamA,
    teamB,
    teamRatingA: match.teamRatingA,
    teamRatingB: match.teamRatingB,
    teamBalance: match.balance,
    skillSpread: match.spread,
    cost: match.cost,
    reasons,
    warnings: warning ? [warning] : [],
  };
}

function selectPlayer(player: MatchmakingPlayer, now: number): SelectedPlayer {
  return {
    queueEntryId: player.id,
    userId: player.userId,
    displayName: player.displayName,
    skill: player.skill,
    gamesPlayed: player.gamesPlayed,
    waitMinutes: round1(waitMinutes(player, now)),
  };
}

function sumSkill(players: MatchmakingPlayer[]): number {
  return players.reduce((sum, player) => sum + player.skill, 0);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Stable non-cryptographic hash (FNV-1a) over ordered snapshot fields. */
export function hashInput(input: MatchmakingInput): string {
  const canonical = JSON.stringify({
    now: input.now,
    strategy: input.strategy ?? input.config.strategy,
    config: input.config,
    format: input.config.format,
    players: [...input.players]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => [
        p.id,
        p.userId,
        p.skill,
        p.gamesPlayed,
        p.waitingSince,
        p.checkedIn,
        p.paused,
        p.left,
        p.restUntil,
        p.currentAssignmentId,
      ]),
    courts: [...input.courts].sort((a, b) => a.id.localeCompare(b.id)).map((c) => [c.id, c.name]),
    recent: [...(input.recentMatches ?? [])]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => [m.id, m.teamAUserIds, m.teamBUserIds]),
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
