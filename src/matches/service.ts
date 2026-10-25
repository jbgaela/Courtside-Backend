import type {
  Court,
  Match,
  MatchParticipant,
  MatchResult,
  PlaySession,
  Prisma,
} from '@prisma/client';
import {
  matchmakingConfigSchema,
  scoringConfigSchema,
  type ScoreTeam,
  type ScoringConfig,
} from '@picklequeue/contracts';
import {
  ScoringError,
  applyPoint,
  createInitialScoreState,
  finalResult,
  replayPoints,
  validateCorrectedGames,
  type GameScore,
  type ScoreState,
} from '@picklequeue/scoring';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';
import { writeAudit } from '../audit/audit.js';
import { getSessionAccess } from '../sessions/access.js';
import { publishSessionEvent } from '../realtime/gateway.js';
import { maybeAutoRotate } from '../matchmaking/service.js';
import { matchDto } from './serializers.js';

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const WRITE_ROLES = ['OWNER', 'QUEUE_MASTER'];

interface AuditMeta {
  ip?: string;
  userAgent?: string;
}

type MatchWithAll = Match & {
  participants: MatchParticipant[];
  court: Court;
  result?: MatchResult | null;
  session?: PlaySession;
};

export interface MatchAccess {
  match: MatchWithAll;
  role: string;
  session: PlaySession;
}

export async function getMatchAccess(matchId: string, userId: string): Promise<MatchAccess> {
  if (!OBJECT_ID.test(matchId)) throw AppError.notFound('Match not found');
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      participants: true,
      court: true,
      result: true,
      session: true,
    },
  });
  if (!match) throw AppError.notFound('Match not found');
  const membership = await prisma.clubMembership.findUnique({
    where: { clubId_userId: { clubId: match.clubId, userId } },
  });
  if (!membership || membership.status !== 'ACTIVE') {
    throw AppError.forbidden('You do not have access to this match');
  }
  const session = match.session!;
  return { match, role: membership.role, session };
}

async function getMatchForAdmin(matchId: string, userId: string): Promise<MatchAccess> {
  const access = await getMatchAccess(matchId, userId);
  if (!WRITE_ROLES.includes(access.role)) {
    throw AppError.forbidden('Only a Queue Master can manage this match');
  }
  return access;
}

function scoringConfig(match: Match): ScoringConfig {
  return scoringConfigSchema.parse(match.configSnapshot);
}

export function scoreStateFromMatch(match: Match): ScoreState {
  const config = scoringConfig(match);
  const games = (match.games as unknown as GameScore[]) ?? [{ a: 0, b: 0 }];
  const status =
    match.status === 'COMPLETED' || match.status === 'CORRECTED'
      ? 'COMPLETED'
      : match.awaitingCompletion
        ? 'AWAITING_COMPLETION'
        : 'IN_PROGRESS';
  return {
    config,
    status,
    games,
    gamesWonA: match.gamesWonA,
    gamesWonB: match.gamesWonB,
    servingTeam: (match.servingTeam as ScoreTeam | null) ?? null,
    winnerTeam: (match.winnerTeam as ScoreTeam | null) ?? null,
  };
}

async function nextSequenceInTx(tx: Prisma.TransactionClient, matchId: string): Promise<number> {
  const last = await tx.scoreEvent.findFirst({
    where: { matchId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });
  return (last?.sequence ?? 0) + 1;
}

export async function startMatch(
  matchId: string,
  actorId: string,
  input: { expectedVersion?: number },
) {
  const access = await getMatchForAdmin(matchId, actorId);
  const match = access.match;
  if (
    match.status === 'IN_PROGRESS' ||
    match.status === 'COMPLETED' ||
    match.status === 'CORRECTED'
  ) {
    return { match: matchDto(match), alreadyStarted: true };
  }
  if (!['READY', 'RESERVED'].includes(match.status)) {
    throw AppError.conflict(`Cannot start a match in ${match.status} state`);
  }
  const expected = input.expectedVersion ?? match.version;
  const config = scoringConfig(match);
  const state = createInitialScoreState(config, 'A');

  const updated = await prisma.$transaction(async (tx) => {
    const guard = await tx.match.updateMany({
      where: { id: matchId, version: expected, status: { in: ['READY', 'RESERVED'] } },
      data: {
        status: 'IN_PROGRESS',
        startedAt: new Date(),
        scorekeeperId: actorId,
        version: { increment: 1 },
      },
    });
    if (guard.count === 0) {
      throw AppError.conflict('The match changed. Refresh the scoreboard and try again.');
    }
    const sequence = await nextSequenceInTx(tx, matchId);
    await tx.scoreEvent.create({
      data: {
        matchId,
        sequence,
        type: 'START',
        points: 0,
        scoreAfter: state as unknown as object,
        actorId,
      },
    });
    await writeAudit(tx, {
      clubId: match.clubId,
      sessionId: match.sessionId,
      actorId,
      action: 'match.started',
      entityType: 'Match',
      entityId: matchId,
      summary: `Match started on ${match.court.name}`,
      ip: undefined,
      userAgent: undefined,
    });
    return tx.match.findUniqueOrThrow({
      where: { id: matchId },
      include: { participants: true, court: true, result: true },
    });
  });

  publishSessionEvent({
    sessionId: match.sessionId,
    publicId: access.session.publicId,
    type: 'match.started',
    version: access.session.version,
    payload: { matchId, matchVersion: updated.version },
    publicPayload: { matchId },
  });
  return { match: matchDto(updated), alreadyStarted: false };
}

export async function recordPoint(
  matchId: string,
  actorId: string,
  input: { team: ScoreTeam; expectedVersion: number },
) {
  const access = await getMatchForAdmin(matchId, actorId);
  const match = access.match;
  if (match.status !== 'IN_PROGRESS') {
    throw AppError.conflict('Start the match before recording points');
  }
  if (match.awaitingCompletion) {
    throw AppError.conflict(
      'The match is awaiting completion. Complete it or undo the last point.',
    );
  }
  if (match.version !== input.expectedVersion) {
    throw AppError.conflict(
      `The score changed (current version ${match.version}). Refresh before recording another point.`,
    );
  }
  const state = scoreStateFromMatch(match);
  let outcome;
  try {
    outcome = applyPoint(state, input.team);
  } catch (error) {
    if (error instanceof ScoringError) throw AppError.conflict(error.message);
    throw error;
  }
  const next = outcome.state;
  const current = next.games[next.games.length - 1] ?? { a: 0, b: 0 };

  const updated = await prisma.$transaction(async (tx) => {
    const guard = await tx.match.updateMany({
      where: {
        id: matchId,
        version: input.expectedVersion,
        status: 'IN_PROGRESS',
        awaitingCompletion: false,
      },
      data: {
        games: next.games as unknown as object,
        gamesWonA: next.gamesWonA,
        gamesWonB: next.gamesWonB,
        servingTeam: next.servingTeam,
        winnerTeam: next.winnerTeam,
        awaitingCompletion: next.status === 'AWAITING_COMPLETION',
        teamAScore: current.a,
        teamBScore: current.b,
        version: { increment: 1 },
      },
    });
    if (guard.count === 0) {
      throw AppError.conflict('Another tablet recorded a point first. Refresh the scoreboard.');
    }
    const sequence = await nextSequenceInTx(tx, matchId);
    await tx.scoreEvent.create({
      data: {
        matchId,
        sequence,
        type: 'POINT',
        team: input.team,
        points: 1,
        scoreAfter: next as unknown as object,
        actorId,
      },
    });
    return tx.match.findUniqueOrThrow({
      where: { id: matchId },
      include: { participants: true, court: true, result: true },
    });
  });

  publishSessionEvent({
    sessionId: match.sessionId,
    publicId: access.session.publicId,
    type: next.status === 'AWAITING_COMPLETION' ? 'match.awaiting_completion' : 'score.updated',
    version: access.session.version,
    payload: {
      matchId,
      matchVersion: updated.version,
      awaitingCompletion: updated.awaitingCompletion,
      winnerTeam: updated.winnerTeam,
    },
    publicPayload: { matchId, awaitingCompletion: updated.awaitingCompletion },
  });
  return {
    match: matchDto(updated),
    gameWon: outcome.gameWon,
    matchDecided: outcome.matchDecided,
    awaitingCompletion: next.status === 'AWAITING_COMPLETION',
  };
}

export async function completeMatch(
  matchId: string,
  actorId: string,
  input: { expectedVersion: number },
  meta: AuditMeta,
) {
  const access = await getMatchForAdmin(matchId, actorId);
  const match = access.match;
  if (match.status === 'COMPLETED' || match.status === 'CORRECTED') {
    return {
      match: matchDto(match),
      alreadyCompleted: true,
      sessionVersion: access.session.version,
    };
  }
  if (match.status !== 'IN_PROGRESS' || !match.awaitingCompletion) {
    throw AppError.conflict('The match has not reached a valid winning condition');
  }
  if (match.version !== input.expectedVersion) {
    throw AppError.conflict('The match changed. Refresh before completing it.');
  }

  const state = scoreStateFromMatch(match);
  let result;
  try {
    result = finalResult(state);
  } catch (error) {
    if (error instanceof ScoringError) throw AppError.conflict(error.message);
    throw error;
  }

  const matchmaking = matchmakingConfigSchema.parse(access.session.matchmakingConfig);
  const now = new Date();
  const restUntil = new Date(now.getTime() + matchmaking.minRestMinutes * 60_000);

  const { updated, sessionVersion } = await prisma.$transaction(async (tx) => {
    const guard = await tx.match.updateMany({
      where: {
        id: matchId,
        version: input.expectedVersion,
        status: 'IN_PROGRESS',
        awaitingCompletion: true,
      },
      data: {
        status: 'COMPLETED',
        awaitingCompletion: false,
        winnerTeam: result.winnerTeam,
        completedAt: now,
        scoringMode: scoringConfig(match).mode,
        version: { increment: 1 },
      },
    });
    if (guard.count === 0) {
      throw AppError.conflict('This match was already completed by another scorekeeper.');
    }
    await tx.matchResult.create({
      data: {
        matchId,
        sessionId: match.sessionId,
        winnerTeam: result.winnerTeam,
        gamesWonA: result.gamesWonA,
        gamesWonB: result.gamesWonB,
        games: result.games as unknown as object,
        completedAt: now,
        recordedById: actorId,
      },
    });

    const queueEntries = await tx.queueEntry.findMany({
      where: {
        sessionId: match.sessionId,
        userId: { in: match.participants.map((p) => p.userId) },
      },
    });
    for (const participant of match.participants) {
      const entry = queueEntries.find((row) => row.userId === participant.userId);
      if (!entry) continue;
      const won = participant.team === result.winnerTeam;
      const keepPaused = entry.state === 'PAUSED';
      const keepLeft = entry.state === 'LEFT';
      await tx.queueEntry.update({
        where: { id: entry.id },
        data: {
          gamesPlayed: { increment: 1 },
          wins: { increment: won ? 1 : 0 },
          losses: { increment: won ? 0 : 1 },
          lastPlayedAt: now,
          restUntil,
          waitingSince: restUntil,
          accumulatedWaitMs: 0,
          currentMatchId: null,
          ...(keepLeft
            ? { state: 'LEFT' }
            : keepPaused
              ? { state: 'PAUSED' }
              : { state: 'WAITING' }),
          version: { increment: 1 },
        },
      });
    }
    await tx.courtAssignment.updateMany({
      where: { matchId, status: 'ACTIVE' },
      data: { status: 'COMPLETED' },
    });
    await tx.court.update({ where: { id: match.courtId }, data: { status: 'AVAILABLE' } });
    const session = await tx.playSession.update({
      where: { id: match.sessionId },
      data: { version: { increment: 1 } },
      select: { version: true },
    });
    const sequence = await nextSequenceInTx(tx, matchId);
    await tx.scoreEvent.create({
      data: {
        matchId,
        sequence,
        type: 'COMPLETE',
        points: 0,
        scoreAfter: { ...state, status: 'COMPLETED' } as unknown as object,
        actorId,
      },
    });
    await writeAudit(tx, {
      clubId: match.clubId,
      sessionId: match.sessionId,
      actorId,
      action: 'match.completed',
      entityType: 'Match',
      entityId: matchId,
      summary: `Match completed: Team ${result.winnerTeam} won ${result.gamesWonA}-${result.gamesWonB}`,
      metadata: {
        winnerTeam: result.winnerTeam,
        games: result.games as unknown as Prisma.InputJsonValue,
        courtId: match.courtId,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    const finalMatch = await tx.match.findUniqueOrThrow({
      where: { id: matchId },
      include: { participants: true, court: true, result: true },
    });
    return { updated: finalMatch, sessionVersion: session.version };
  });

  publishSessionEvent({
    sessionId: match.sessionId,
    publicId: access.session.publicId,
    type: 'match.completed',
    version: sessionVersion,
    payload: {
      matchId,
      matchVersion: updated.version,
      winnerTeam: result.winnerTeam,
      score: updated.games,
    },
    publicPayload: { matchId, winnerTeam: result.winnerTeam },
  });
  publishSessionEvent({
    sessionId: match.sessionId,
    publicId: access.session.publicId,
    type: 'queue.updated',
    version: sessionVersion,
  });

  setImmediate(() => {
    void maybeAutoRotate(match.sessionId);
  });

  return { match: matchDto(updated), alreadyCompleted: false, sessionVersion };
}

export async function undoLastPoint(
  matchId: string,
  actorId: string,
  input: { expectedVersion: number },
) {
  const access = await getMatchForAdmin(matchId, actorId);
  const match = access.match;
  if (match.status !== 'IN_PROGRESS') {
    throw AppError.conflict('Only an in-progress match can undo points');
  }
  if (match.version !== input.expectedVersion) {
    throw AppError.conflict('The match changed. Refresh before undoing.');
  }
  const events = await prisma.scoreEvent.findMany({
    where: { matchId },
    orderBy: { sequence: 'asc' },
  });
  const points: ScoreTeam[] = [];
  for (const event of events) {
    if (event.type === 'POINT' && (event.team === 'A' || event.team === 'B'))
      points.push(event.team);
    if (event.type === 'UNDO') points.pop();
  }
  if (points.length === 0) throw AppError.conflict('There are no points to undo');
  points.pop();
  const next = replayPoints(scoringConfig(match), 'A', points);
  const current = next.games[next.games.length - 1] ?? { a: 0, b: 0 };

  const updated = await prisma.$transaction(async (tx) => {
    const guard = await tx.match.updateMany({
      where: { id: matchId, version: input.expectedVersion, status: 'IN_PROGRESS' },
      data: {
        games: next.games as unknown as object,
        gamesWonA: next.gamesWonA,
        gamesWonB: next.gamesWonB,
        servingTeam: next.servingTeam,
        winnerTeam: next.winnerTeam,
        awaitingCompletion: next.status === 'AWAITING_COMPLETION',
        teamAScore: current.a,
        teamBScore: current.b,
        version: { increment: 1 },
      },
    });
    if (guard.count === 0) throw AppError.conflict('The match changed. Refresh before undoing.');
    const sequence = await nextSequenceInTx(tx, matchId);
    await tx.scoreEvent.create({
      data: {
        matchId,
        sequence,
        type: 'UNDO',
        points: 0,
        scoreAfter: next as unknown as object,
        actorId,
      },
    });
    await writeAudit(tx, {
      clubId: match.clubId,
      sessionId: match.sessionId,
      actorId,
      action: 'match.point_undone',
      entityType: 'Match',
      entityId: matchId,
      summary: 'Last point undone',
      ip: undefined,
      userAgent: undefined,
    });
    return tx.match.findUniqueOrThrow({
      where: { id: matchId },
      include: { participants: true, court: true, result: true },
    });
  });

  publishSessionEvent({
    sessionId: match.sessionId,
    publicId: access.session.publicId,
    type: 'score.updated',
    version: access.session.version,
    payload: { matchId, matchVersion: updated.version },
  });
  return { match: matchDto(updated) };
}

export async function correctMatch(
  matchId: string,
  actorId: string,
  input: { games: GameScore[]; reason: string; expectedVersion?: number },
  meta: AuditMeta,
) {
  const access = await getMatchForAdmin(matchId, actorId);
  const match = access.match;
  if (!access.match.result) throw AppError.conflict('Match has no recorded result to correct');
  if (match.status !== 'COMPLETED' && match.status !== 'CORRECTED') {
    throw AppError.conflict('Only a completed match can be corrected');
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== match.version) {
    throw AppError.conflict('The match changed. Refresh before correcting.');
  }
  const config = scoringConfig(match);
  try {
    validateCorrectedGames(input.games, config);
  } catch (error) {
    if (error instanceof ScoringError) throw AppError.unprocessable(error.message);
    throw error;
  }
  const gamesWonA = input.games.filter((game) => game.a > game.b).length;
  const gamesWonB = input.games.filter((game) => game.b > game.a).length;
  const winnerTeam: ScoreTeam = gamesWonA > gamesWonB ? 'A' : 'B';
  const oldWinner = access.match.result.winnerTeam as ScoreTeam;
  const last = input.games[input.games.length - 1] ?? { a: 0, b: 0 };
  const now = new Date();

  const { updated, sessionVersion } = await prisma.$transaction(async (tx) => {
    const guard = await tx.match.updateMany({
      where: { id: matchId, version: match.version, status: match.status },
      data: {
        games: input.games as unknown as object,
        gamesWonA,
        gamesWonB,
        winnerTeam,
        teamAScore: last.a,
        teamBScore: last.b,
        status: 'CORRECTED',
        correctedAt: now,
        correctionReason: input.reason,
        version: { increment: 1 },
      },
    });
    if (guard.count === 0) throw AppError.conflict('The match changed. Refresh and try again.');
    await tx.matchResult.update({
      where: { matchId },
      data: {
        winnerTeam,
        gamesWonA,
        gamesWonB,
        games: input.games as unknown as object,
        correctedAt: now,
        correctionReason: input.reason,
      },
    });
    if (oldWinner !== winnerTeam) {
      const entries = await tx.queueEntry.findMany({
        where: {
          sessionId: match.sessionId,
          userId: { in: match.participants.map((p) => p.userId) },
        },
      });
      for (const participant of match.participants) {
        const entry = entries.find((row) => row.userId === participant.userId);
        if (!entry) continue;
        if (participant.team === oldWinner) {
          await tx.queueEntry.update({
            where: { id: entry.id },
            data: { wins: Math.max(0, entry.wins - 1), losses: entry.losses + 1 },
          });
        } else if (participant.team === winnerTeam) {
          await tx.queueEntry.update({
            where: { id: entry.id },
            data: { wins: entry.wins + 1, losses: Math.max(0, entry.losses - 1) },
          });
        }
      }
    }
    const session = await tx.playSession.update({
      where: { id: match.sessionId },
      data: { version: { increment: 1 } },
      select: { version: true },
    });
    const sequence = await nextSequenceInTx(tx, matchId);
    await tx.scoreEvent.create({
      data: {
        matchId,
        sequence,
        type: 'CORRECTION',
        points: 0,
        scoreAfter: { games: input.games, winnerTeam } as unknown as object,
        actorId,
        reason: input.reason,
      },
    });
    await writeAudit(tx, {
      clubId: match.clubId,
      sessionId: match.sessionId,
      actorId,
      action: 'match.corrected',
      entityType: 'Match',
      entityId: matchId,
      summary: `Match result corrected: Team ${winnerTeam} won ${gamesWonA}-${gamesWonB}`,
      metadata: {
        reason: input.reason,
        previousWinner: oldWinner,
        winnerTeam,
        games: input.games as unknown as Prisma.InputJsonValue,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return {
      updated: await tx.match.findUniqueOrThrow({
        where: { id: matchId },
        include: { participants: true, court: true, result: true },
      }),
      sessionVersion: session.version,
    };
  });

  publishSessionEvent({
    sessionId: match.sessionId,
    publicId: access.session.publicId,
    type: 'match.corrected',
    version: sessionVersion,
    payload: { matchId, matchVersion: updated.version, winnerTeam },
    publicPayload: { matchId, winnerTeam },
  });
  return { match: matchDto(updated) };
}

export async function getMatchDetail(matchId: string, userId: string) {
  const access = await getMatchAccess(matchId, userId);
  return matchDto(access.match);
}

export async function getMatchEvents(matchId: string, userId: string) {
  await getMatchForAdmin(matchId, userId);
  const events = await prisma.scoreEvent.findMany({
    where: { matchId },
    orderBy: { sequence: 'asc' },
  });
  return events.map((event) => ({
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    team: event.team,
    points: event.points,
    scoreAfter: event.scoreAfter,
    actorId: event.actorId,
    reason: event.reason,
    createdAt: event.createdAt.toISOString(),
  }));
}

export async function listSessionMatches(
  sessionId: string,
  userId: string,
  query: { status?: string; limit: number },
  resultsOnly = false,
) {
  await getSessionAccess(sessionId, userId);
  const statuses = query.status ? query.status.split(',').filter(Boolean) : null;
  const matches = await prisma.match.findMany({
    where: {
      sessionId,
      ...(resultsOnly
        ? { status: { in: ['COMPLETED', 'CORRECTED'] } }
        : statuses && statuses.length > 0
          ? { status: { in: statuses } }
          : {}),
    },
    include: { participants: true, court: true, result: true },
    orderBy: [{ round: 'desc' }, { createdAt: 'desc' }],
    take: query.limit,
  });
  return matches.map((match) => matchDto(match));
}
