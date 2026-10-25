import { Prisma } from '@prisma/client';
import type {
  Match,
  MatchParticipant,
  Court,
  PlaySession,
  RotationRun,
  CourtAssignment,
} from '@prisma/client';
import { z } from 'zod';
import {
  MATCHMAKING_DEFAULTS,
  matchmakingConfigSchema,
  scoringConfigSchema,
  type MatchmakingConfig,
} from '@picklequeue/contracts';
import {
  proposeMatches,
  type MatchmakingCourt,
  type SelectedPlayer,
  type MatchmakingResult,
} from '@picklequeue/matchmaking';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';
import { logger } from '../infrastructure/logger.js';
import { env } from '../config/env.js';
import { generatePublicId } from '../security/tokens.js';
import { writeAudit } from '../audit/audit.js';
import { getSessionAccess, getSessionForAdmin } from '../sessions/access.js';
import { publishSessionEvent } from '../realtime/gateway.js';
import { matchDto } from '../matches/serializers.js';
import { selectedPlayerSchema } from './schemas.js';
import type { GameScore } from '@picklequeue/scoring';

interface AuditMeta {
  ip?: string;
  userAgent?: string;
}

const ACTIVE_MATCH_STATUSES = ['PROPOSED', 'RESERVED', 'READY', 'IN_PROGRESS'];

type MatchWithAll = Match & {
  participants: MatchParticipant[];
  court: Court;
};

export interface RotationDto {
  rotationId: string;
  sessionId: string;
  sessionVersion: number;
  rotationSessionVersion: number;
  stale: boolean;
  status: string;
  strategy: string;
  format: string;
  config: MatchmakingConfig;
  metrics: unknown;
  warnings: string[];
  bench: unknown[];
  expiresAt: string;
  createdAt: string;
  assignments: Array<{
    id: string;
    courtId: string;
    courtName: string;
    status: string;
    teamA: SelectedPlayer[];
    teamB: SelectedPlayer[];
    teamRatingA: number;
    teamRatingB: number;
    teamBalance: number;
    skillSpread: number;
    reasons: string[];
    warnings: string[];
    matchId: string | null;
  }>;
}

function parseSelectedPlayers(value: Prisma.JsonValue): SelectedPlayer[] {
  const result = selectedPlayerSchema.array().safeParse(value);
  return result.success ? result.data : [];
}

const benchEntrySchema = z.object({
  queueEntryId: z.string(),
  userId: z.string(),
  participantType: z.enum(['REGISTERED', 'GUEST']).optional(),
  displayName: z.string(),
  gamesPlayed: z.number(),
  waitMinutes: z.number(),
  reason: z.string(),
});

type BenchEntry = z.infer<typeof benchEntrySchema>;

function parseBench(value: Prisma.JsonValue): BenchEntry[] {
  const result = benchEntrySchema.array().safeParse(value);
  return result.success ? result.data : [];
}

function rotationDto(
  run: RotationRun,
  assignments: Array<CourtAssignment & { court: Court }>,
  sessionVersion: number,
): RotationDto {
  return {
    rotationId: run.id,
    sessionId: run.sessionId,
    sessionVersion,
    rotationSessionVersion: run.sessionVersion,
    stale: run.sessionVersion !== sessionVersion || run.status !== 'PREVIEW',
    status: run.status,
    strategy: run.strategy,
    format: run.format,
    config: matchmakingConfigSchema.parse(run.configSnapshot),
    metrics: run.metrics,
    warnings: Array.isArray(run.warnings) ? (run.warnings as string[]) : [],
    bench: Array.isArray(run.bench) ? (run.bench as unknown[]) : [],
    expiresAt: run.expiresAt.toISOString(),
    createdAt: run.createdAt.toISOString(),
    assignments: assignments.map((assignment) => ({
      id: assignment.id,
      courtId: assignment.courtId,
      courtName: assignment.court.name,
      status: assignment.status,
      teamA: parseSelectedPlayers(assignment.teamA),
      teamB: parseSelectedPlayers(assignment.teamB),
      teamRatingA: assignment.teamRatingA,
      teamRatingB: assignment.teamRatingB,
      teamBalance: assignment.teamBalance,
      skillSpread: assignment.skillSpread,
      reasons: Array.isArray(assignment.reasons) ? (assignment.reasons as string[]) : [],
      warnings: Array.isArray(assignment.warnings) ? (assignment.warnings as string[]) : [],
      matchId: assignment.matchId,
    })),
  };
}

async function loadSnapshot(
  session: PlaySession,
  maxAssignments?: number,
): Promise<{
  engineResult: MatchmakingResult;
  courts: MatchmakingCourt[];
  config: MatchmakingConfig;
  freeCourtCount: number;
}> {
  const config = matchmakingConfigSchema.parse(session.matchmakingConfig);
  const [
    queueEntries,
    registrations,
    sessionCourts,
    busyMatches,
    activeAssignments,
    recentMatches,
  ] = await Promise.all([
    prisma.queueEntry.findMany({
      where: { sessionId: session.id, state: { in: ['WAITING', 'RESTING', 'PAUSED'] } },
      include: { user: { include: { profile: true } }, guest: true },
      orderBy: [{ gamesPlayed: 'asc' }, { waitingSince: 'asc' }],
    }),
    prisma.sessionRegistration.findMany({
      where: { sessionId: session.id },
      select: { userId: true, status: true },
    }),
    prisma.sessionCourt.findMany({
      where: { sessionId: session.id, active: true },
      include: { court: true },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.match.findMany({
      where: {
        courtId: {
          in: (
            await prisma.sessionCourt.findMany({
              where: { sessionId: session.id, active: true },
              select: { courtId: true },
            })
          ).map((row) => row.courtId),
        },
        status: { in: ACTIVE_MATCH_STATUSES },
      },
      select: { courtId: true },
    }),
    prisma.courtAssignment.findMany({
      where: { sessionId: session.id, status: 'ACTIVE' },
      select: { courtId: true },
    }),
    prisma.match.findMany({
      where: { sessionId: session.id, status: { in: ['COMPLETED', 'CORRECTED'] } },
      orderBy: { completedAt: 'desc' },
      take: 20,
      include: { participants: { select: { participantId: true, team: true } } },
    }),
  ]);

  const busyCourtIds = new Set([
    ...busyMatches.map((match) => match.courtId),
    ...activeAssignments.map((assignment) => assignment.courtId),
  ]);
  const free = sessionCourts.filter(
    (row) => row.court.status === 'AVAILABLE' && !busyCourtIds.has(row.courtId),
  );
  const courts: MatchmakingCourt[] = free.map((row) => ({
    id: row.court.id,
    name: row.court.name,
  }));
  if (courts.length === 0) {
    throw AppError.conflict('All courts are currently occupied or unavailable');
  }

  const registeredUserIds = queueEntries
    .filter((entry) => entry.participantType === 'REGISTERED' && entry.userId)
    .map((entry) => entry.userId!);
  const activeMemberIds = new Set(
    (
      await prisma.clubMembership.findMany({
        where: {
          clubId: session.clubId,
          userId: { in: registeredUserIds },
          status: 'ACTIVE',
          user: { accountStatus: 'ACTIVE' },
        },
        select: { userId: true },
      })
    ).map((row) => row.userId),
  );
  const registrationMap = new Map(registrations.map((row) => [row.userId, row.status]));
  const now = Date.now();
  const eligibleEntries = queueEntries.filter((entry) => {
    if (entry.participantType === 'GUEST') {
      return entry.guest?.status === 'ACTIVE';
    }
    return Boolean(entry.userId && activeMemberIds.has(entry.userId));
  });
  const players = eligibleEntries.map((entry) => ({
    id: entry.id,
    // The engine treats userId as a stable participant identity. Guests use
    // their guest id here; no authenticated account is implied.
    userId: entry.participantId,
    participantType: entry.participantType as 'REGISTERED' | 'GUEST',
    displayName:
      entry.guest?.displayName ??
      entry.user?.profile?.displayName ??
      entry.user?.name ??
      'Unknown player',
    skill: entry.guest?.skillRating ?? entry.user?.profile?.skillRating ?? 3,
    gamesPlayed: entry.gamesPlayed,
    waitingSince: entry.waitingSince.getTime(),
    checkedIn:
      entry.participantType === 'GUEST'
        ? true
        : entry.userId
          ? registrationMap.get(entry.userId) === 'CHECKED_IN'
          : false,
    paused: entry.state === 'PAUSED',
    left: entry.state === 'LEFT',
    restUntil: entry.restUntil?.getTime() ?? null,
    currentAssignmentId: entry.currentMatchId ?? null,
    wins: entry.wins,
    losses: entry.losses,
  }));

  const engineResult = proposeMatches({
    now,
    config: { ...config, format: session.format === 'SINGLES' ? 'SINGLES' : 'DOUBLES' },
    players,
    courts,
    maxAssignments,
    recentMatches: recentMatches.map((match) => ({
      id: match.id,
      round: match.round,
      completedAt: match.completedAt?.getTime() ?? match.createdAt.getTime(),
      teamAUserIds: match.participants.filter((p) => p.team === 'A').map((p) => p.participantId),
      teamBUserIds: match.participants.filter((p) => p.team === 'B').map((p) => p.participantId),
    })),
  });

  return {
    engineResult,
    courts,
    config: { ...config, format: session.format === 'SINGLES' ? 'SINGLES' : 'DOUBLES' },
    freeCourtCount: courts.length,
  };
}

async function expirePreviews(sessionId: string): Promise<void> {
  await prisma.rotationRun.updateMany({
    where: { sessionId, status: 'PREVIEW', expiresAt: { lt: new Date() } },
    data: { status: 'EXPIRED' },
  });
}

export async function createPreview(
  sessionId: string,
  actorId: string,
  input: { maxAssignments?: number } = {},
): Promise<RotationDto> {
  const access = await getSessionForAdmin(sessionId, actorId);
  if (access.session.status !== 'LIVE') {
    throw AppError.conflict('Rotations can only be generated for a live session');
  }
  await expirePreviews(sessionId);
  const snapshot = await loadSnapshot(access.session, input.maxAssignments);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.PREVIEW_TTL_SECONDS * 1000);
  const run = await prisma.$transaction(async (tx) => {
    await tx.rotationRun.updateMany({
      where: { sessionId, status: 'PREVIEW' },
      data: { status: 'SUPERSEDED', supersededAt: now },
    });
    await tx.courtAssignment.updateMany({
      where: {
        sessionId,
        status: 'PROPOSED',
      },
      data: { status: 'CANCELLED' },
    });
    const created = await tx.rotationRun.create({
      data: {
        sessionId,
        status: 'PREVIEW',
        strategy: snapshot.config.strategy,
        format: snapshot.config.format,
        configSnapshot: snapshot.config as unknown as object,
        metrics: snapshot.engineResult.metrics as unknown as object,
        warnings: snapshot.engineResult.warnings as unknown as object,
        bench: snapshot.engineResult.bench as unknown as object,
        inputHash: snapshot.engineResult.inputHash,
        sessionVersion: access.session.version,
        expiresAt,
        createdById: actorId,
        assignments: {
          create: snapshot.engineResult.assignments.map((assignment) => ({
            sessionId,
            clubId: access.session.clubId,
            courtId: assignment.courtId,
            status: 'PROPOSED',
            teamA: assignment.teamA as unknown as object,
            teamB: assignment.teamB as unknown as object,
            teamRatingA: assignment.teamRatingA,
            teamRatingB: assignment.teamRatingB,
            teamBalance: assignment.teamBalance,
            skillSpread: assignment.skillSpread,
            reasons: assignment.reasons as unknown as object,
            warnings: assignment.warnings as unknown as object,
            cost: assignment.cost,
          })),
        },
      },
      include: { assignments: { include: { court: true } } },
    });
    await writeAudit(tx, {
      clubId: access.session.clubId,
      sessionId,
      actorId,
      action: 'rotation.previewed',
      entityType: 'RotationRun',
      entityId: created.id,
      summary: `Rotation preview generated for ${snapshot.engineResult.assignments.length} court(s)`,
      metadata: {
        assignmentCount: snapshot.engineResult.assignments.length,
        warnings: snapshot.engineResult.warnings,
        sessionVersion: access.session.version,
      },
    });
    return created;
  });

  publishSessionEvent({
    sessionId,
    publicId: access.session.publicId,
    type: 'rotation.proposed',
    version: access.session.version,
    payload: { rotationId: run.id },
    publicPayload: { rotationProposed: true },
  });

  return rotationDto(run, run.assignments, access.session.version);
}

async function loadMatchesForRotation(rotationId: string): Promise<MatchWithAll[]> {
  return prisma.match.findMany({
    where: { rotationId },
    include: { participants: true, court: true },
    orderBy: { court: { name: 'asc' } },
  });
}

export async function commitRotation(
  sessionId: string,
  actorId: string,
  input: { rotationId: string; expectedSessionVersion: number; idempotencyKey?: string },
  meta: AuditMeta & { userAgent?: string } = {},
) {
  const access = await getSessionForAdmin(sessionId, actorId);
  if (access.session.status !== 'LIVE') {
    throw AppError.conflict('Rotations can only be committed for a live session');
  }
  const rotation = await prisma.rotationRun.findFirst({
    where: { id: input.rotationId, sessionId },
    include: { assignments: { include: { court: true } } },
  });
  if (!rotation) throw AppError.notFound('Rotation preview not found');

  if (rotation.status === 'COMMITTED') {
    const matches = await loadMatchesForRotation(rotation.id);
    return {
      alreadyCommitted: true,
      sessionVersion: access.session.version,
      matches: matches.map((match) => matchDto(match)),
    };
  }
  if (rotation.status !== 'PREVIEW') {
    throw AppError.conflict(
      `This rotation is ${rotation.status.toLowerCase()} and cannot be committed`,
    );
  }
  if (rotation.expiresAt.getTime() <= Date.now()) {
    await prisma.rotationRun.update({
      where: { id: rotation.id },
      data: { status: 'EXPIRED' },
    });
    throw AppError.conflict('This rotation preview has expired. Generate a new preview.');
  }
  if (rotation.sessionVersion !== access.session.version) {
    throw AppError.conflict('Eligibility changed since this preview. Generate a new preview.');
  }
  if (input.expectedSessionVersion !== access.session.version) {
    throw AppError.conflict('The session changed since you loaded it. Refresh and try again.');
  }
  if (rotation.assignments.length === 0) {
    throw AppError.conflict('This preview has no assignments to commit');
  }

  const assignments = rotation.assignments.map((assignment) => ({
    assignment,
    teamA: parseSelectedPlayers(assignment.teamA),
    teamB: parseSelectedPlayers(assignment.teamB),
  }));
  const allPlayers = assignments.flatMap(({ teamA, teamB }) => [...teamA, ...teamB]);
  const playerIds = allPlayers.map((player) => player.userId);
  const registeredPlayerIds = allPlayers
    .filter((player) => player.participantType !== 'GUEST')
    .map((player) => player.userId);
  if (new Set(playerIds).size !== playerIds.length) {
    throw AppError.conflict('The preview contains a duplicate player and cannot be committed');
  }
  const courtIds = assignments.map(({ assignment }) => assignment.courtId);
  if (new Set(courtIds).size !== courtIds.length) {
    throw AppError.conflict('The preview contains a duplicate court and cannot be committed');
  }

  const scoring = scoringConfigSchema.parse(access.session.scoringConfig);
  const sessionConfig = matchmakingConfigSchema.parse(access.session.matchmakingConfig);
  const now = new Date();

  const { matches, sessionVersion } = await prisma.$transaction(async (tx) => {
    const guardedRun = await tx.rotationRun.updateMany({
      where: { id: rotation.id, sessionId, status: 'PREVIEW', expiresAt: { gt: now } },
      data: { status: 'COMMITTED', committedAt: now, version: { increment: 1 } },
    });
    if (guardedRun.count === 0) {
      throw AppError.conflict('This rotation was already committed or expired');
    }

    const registrationRows = await tx.sessionRegistration.findMany({
      where: { sessionId, userId: { in: registeredPlayerIds } },
      select: { userId: true, status: true },
    });
    const registrationMap = new Map(registrationRows.map((row) => [row.userId, row.status]));
    const queueRows = await tx.queueEntry.findMany({
      where: { sessionId, participantId: { in: playerIds } },
      include: { user: { include: { profile: true } }, guest: true },
    });
    const queueMap = new Map(queueRows.map((row) => [row.participantId, row]));
    const activeMemberships = await tx.clubMembership.findMany({
      where: {
        clubId: access.session.clubId,
        userId: { in: registeredPlayerIds },
        status: 'ACTIVE',
        user: { accountStatus: 'ACTIVE' },
      },
      select: { userId: true },
    });
    const activeMemberIds = new Set(activeMemberships.map((row) => row.userId));
    const invalid: string[] = [];
    for (const player of allPlayers) {
      const entry = queueMap.get(player.userId);
      const isGuest = player.participantType === 'GUEST' || entry?.participantType === 'GUEST';
      if (!entry) {
        invalid.push(`${player.displayName} is no longer in the queue`);
        continue;
      }
      if (isGuest) {
        if (entry.guest?.status !== 'ACTIVE') {
          invalid.push(`${player.displayName} is no longer an active guest`);
        }
      } else {
        if (!activeMemberIds.has(player.userId)) {
          invalid.push(`${player.displayName} is no longer an active club member`);
          continue;
        }
        if (registrationMap.get(player.userId) !== 'CHECKED_IN') {
          invalid.push(`${player.displayName} is not checked in`);
        }
      }
      if (!['WAITING', 'RESTING'].includes(entry.state)) {
        invalid.push(`${player.displayName} is ${entry.state.toLowerCase()}`);
      }
      if (entry.currentMatchId) invalid.push(`${player.displayName} already has a match`);
      if (entry.restUntil && entry.restUntil.getTime() > now.getTime()) {
        invalid.push(`${player.displayName} is still resting`);
      }
      if (
        sessionConfig.maxGamesPerPlayer !== null &&
        entry.gamesPlayed >= sessionConfig.maxGamesPerPlayer
      ) {
        invalid.push(`${player.displayName} has reached the game cap`);
      }
    }

    for (const { assignment } of assignments) {
      const sessionCourt = await tx.sessionCourt.findUnique({
        where: { sessionId_courtId: { sessionId, courtId: assignment.courtId } },
      });
      if (!sessionCourt?.active)
        invalid.push(`Court ${assignment.court.name} is not active for this session`);
      const court = await tx.court.findUnique({ where: { id: assignment.courtId } });
      if (!court || court.status !== 'AVAILABLE') {
        invalid.push(`Court ${assignment.court.name} is not available`);
      }
      const occupied = await tx.match.findFirst({
        where: { courtId: assignment.courtId, status: { in: ACTIVE_MATCH_STATUSES } },
        select: { id: true },
      });
      if (occupied) invalid.push(`Court ${assignment.court.name} already has an active match`);
      const activeAssignment = await tx.courtAssignment.findFirst({
        where: { courtId: assignment.courtId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (activeAssignment)
        invalid.push(`Court ${assignment.court.name} already has an active assignment`);
    }

    if (invalid.length > 0) {
      throw AppError.conflict(
        `The rotation is stale and cannot be committed: ${invalid.join('; ')}`,
      );
    }

    const maxRound = await tx.match.aggregate({
      where: { sessionId },
      _max: { round: true },
    });
    const round = (maxRound._max.round ?? 0) + 1;
    const createdMatches: MatchWithAll[] = [];

    for (const { assignment, teamA, teamB } of assignments) {
      const match = await tx.match.create({
        data: {
          sessionId,
          clubId: access.session.clubId,
          courtId: assignment.courtId,
          rotationId: rotation.id,
          assignmentId: assignment.id,
          publicId: generatePublicId('m'),
          round,
          format: access.session.format,
          status: 'READY',
          scoringMode: scoring.mode,
          targetScore: scoring.targetScore,
          winByTwo: scoring.winByTwo,
          pointCap: scoring.pointCap,
          bestOf: scoring.bestOf,
          games: [{ a: 0, b: 0 }] as unknown as object,
          configSnapshot: scoring as unknown as object,
          participants: {
            create: [...teamA, ...teamB].map((player, index) => {
              const entry = queueMap.get(player.userId)!;
              return {
                participantId: entry.participantId,
                participantType: entry.participantType,
                userId: entry.userId,
                guestId: entry.guestId,
                team: index < teamA.length ? 'A' : 'B',
                position: index < teamA.length ? index : index - teamA.length,
                displayName:
                  entry.guest?.displayName ??
                  entry.user?.profile?.displayName ??
                  entry.user?.name ??
                  player.displayName,
                skillRating:
                  entry.guest?.skillRating ?? entry.user?.profile?.skillRating ?? player.skill,
              };
            }),
          },
        },
        include: { participants: true, court: true },
      });
      createdMatches.push(match);
      await tx.courtAssignment.update({
        where: { id: assignment.id },
        data: { status: 'ACTIVE', matchId: match.id },
      });
      await tx.court.update({
        where: { id: assignment.courtId },
        data: { status: 'IN_USE' },
      });
      for (const player of [...teamA, ...teamB]) {
        await tx.queueEntry.update({
          where: {
            sessionId_participantId: { sessionId, participantId: player.userId },
          },
          data: {
            state: 'PLAYING',
            currentMatchId: match.id,
            version: { increment: 1 },
          },
        });
      }
    }

    await tx.rotationRun.updateMany({
      where: { sessionId, status: 'PREVIEW', id: { not: rotation.id } },
      data: { status: 'SUPERSEDED', supersededAt: now },
    });
    await tx.courtAssignment.updateMany({
      where: { sessionId, status: 'PROPOSED', rotationId: { not: rotation.id } },
      data: { status: 'CANCELLED' },
    });

    const sessionUpdate = await tx.playSession.updateMany({
      where: { id: sessionId, version: input.expectedSessionVersion },
      data: { version: { increment: 1 } },
    });
    if (sessionUpdate.count === 0) {
      throw AppError.conflict('The session changed while committing. Refresh and try again.');
    }
    const updatedSession = await tx.playSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { version: true },
    });

    await writeAudit(tx, {
      clubId: access.session.clubId,
      sessionId,
      actorId,
      action: 'rotation.committed',
      entityType: 'RotationRun',
      entityId: rotation.id,
      summary: `Rotation committed: ${createdMatches.length} match(es) on court`,
      metadata: {
        rotationId: rotation.id,
        matchIds: createdMatches.map((match) => match.id),
        round,
        idempotencyKey: input.idempotencyKey ?? null,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { matches: createdMatches, sessionVersion: updatedSession.version };
  });

  publishSessionEvent({
    sessionId,
    publicId: access.session.publicId,
    type: 'rotation.committed',
    version: sessionVersion,
    payload: {
      rotationId: rotation.id,
      matchIds: matches.map((match) => match.id),
    },
    publicPayload: { matchesCreated: matches.length },
  });
  for (const match of matches) {
    publishSessionEvent({
      sessionId,
      publicId: access.session.publicId,
      type: 'match.created',
      version: sessionVersion,
      payload: { matchId: match.id, courtId: match.courtId, matchVersion: match.version },
      publicPayload: { matchId: match.id },
    });
  }

  return {
    alreadyCommitted: false,
    sessionVersion,
    matches: matches.map((match) => matchDto(match)),
  };
}

export async function overridePreviewPlayer(
  sessionId: string,
  actorId: string,
  rotationId: string,
  input: { playerUserId: string; replacementUserId: string },
  meta: AuditMeta,
): Promise<RotationDto> {
  const access = await getSessionForAdmin(sessionId, actorId);
  if (access.session.status !== 'LIVE') {
    throw AppError.conflict('Rotations can only be overridden for a live session');
  }
  const rotation = await prisma.rotationRun.findFirst({
    where: { id: rotationId, sessionId },
    include: { assignments: { include: { court: true } } },
  });
  if (!rotation) throw AppError.notFound('Rotation preview not found');
  if (rotation.status !== 'PREVIEW') {
    throw AppError.conflict('Only a pending preview can be overridden');
  }
  if (rotation.expiresAt.getTime() <= Date.now()) {
    throw AppError.conflict('This preview has expired. Generate a new rotation.');
  }
  if (rotation.sessionVersion !== access.session.version) {
    throw AppError.conflict('Eligibility changed since this preview. Generate a new rotation.');
  }
  if (input.playerUserId === input.replacementUserId) {
    throw AppError.badRequest('Choose a different player to swap');
  }

  const assignment = rotation.assignments.find((row) => {
    const teamA = parseSelectedPlayers(row.teamA);
    const teamB = parseSelectedPlayers(row.teamB);
    return [...teamA, ...teamB].some((player) => player.userId === input.playerUserId);
  });
  if (!assignment) {
    throw AppError.badRequest('That player is not in this rotation');
  }
  const teamA = parseSelectedPlayers(assignment.teamA);
  const teamB = parseSelectedPlayers(assignment.teamB);
  const replaced = [...teamA, ...teamB].find((player) => player.userId === input.playerUserId);
  if (!replaced) throw AppError.badRequest('That player is not in this rotation');

  const bench = parseBench(rotation.bench);
  const benchEntry = bench.find((entry) => entry.userId === input.replacementUserId);
  if (!benchEntry) {
    throw AppError.badRequest('The replacement must currently be on the bench');
  }

  const queueEntry = await prisma.queueEntry.findUnique({
    where: {
      sessionId_participantId: { sessionId, participantId: input.replacementUserId },
    },
    include: { user: { include: { profile: true } }, guest: true },
  });
  if (
    !queueEntry ||
    !['WAITING', 'RESTING'].includes(queueEntry.state) ||
    queueEntry.currentMatchId
  ) {
    throw AppError.conflict('The replacement is no longer eligible to enter the rotation');
  }
  const isGuest = queueEntry.participantType === 'GUEST';
  if (isGuest) {
    if (queueEntry.guest?.status !== 'ACTIVE') {
      throw AppError.conflict('The replacement is no longer an active guest');
    }
  } else {
    const [registration, membership] = await Promise.all([
      prisma.sessionRegistration.findUnique({
        where: { sessionId_userId: { sessionId, userId: input.replacementUserId } },
      }),
      prisma.clubMembership.findUnique({
        where: {
          clubId_userId: { clubId: access.session.clubId, userId: input.replacementUserId },
        },
        select: { status: true },
      }),
    ]);
    if (membership?.status !== 'ACTIVE' || queueEntry.user?.accountStatus !== 'ACTIVE') {
      throw AppError.conflict('The replacement is no longer eligible to enter the rotation');
    }
    if (registration?.status !== 'CHECKED_IN') {
      throw AppError.conflict('The replacement is not checked in');
    }
  }
  if (queueEntry.restUntil && queueEntry.restUntil.getTime() > Date.now()) {
    throw AppError.conflict('The replacement is still resting');
  }
  const config = matchmakingConfigSchema.parse(access.session.matchmakingConfig);
  if (config.maxGamesPerPlayer !== null && queueEntry.gamesPlayed >= config.maxGamesPerPlayer) {
    throw AppError.conflict('The replacement has reached the game cap');
  }

  const replacement: SelectedPlayer = {
    queueEntryId: queueEntry.id,
    userId: queueEntry.participantId,
    participantType: queueEntry.participantType as 'REGISTERED' | 'GUEST',
    displayName:
      queueEntry.guest?.displayName ??
      queueEntry.user?.profile?.displayName ??
      queueEntry.user?.name ??
      'Player',
    skill: queueEntry.guest?.skillRating ?? queueEntry.user?.profile?.skillRating ?? 3,
    gamesPlayed: queueEntry.gamesPlayed,
    waitMinutes: Math.round(Math.max(0, Date.now() - queueEntry.waitingSince.getTime()) / 60_000),
  };
  const nextTeamA = teamA.map((player) =>
    player.userId === input.playerUserId ? replacement : player,
  );
  const nextTeamB = teamB.map((player) =>
    player.userId === input.playerUserId ? replacement : player,
  );
  const ratingA = nextTeamA.reduce((sum, player) => sum + player.skill, 0);
  const ratingB = nextTeamB.reduce((sum, player) => sum + player.skill, 0);
  const allSkills = [...nextTeamA, ...nextTeamB].map((player) => player.skill);
  const skillSpread = Math.max(...allSkills) - Math.min(...allSkills);
  const nextBench = [
    ...bench.filter((entry) => entry.userId !== input.replacementUserId),
    {
      queueEntryId: replaced.queueEntryId,
      userId: replaced.userId,
      participantType: replaced.participantType,
      displayName: replaced.displayName,
      gamesPlayed: replaced.gamesPlayed,
      waitMinutes: replaced.waitMinutes,
      reason: 'Swapped out by Queue Master',
    },
  ];
  const reasons = Array.isArray(assignment.reasons) ? (assignment.reasons as string[]) : [];
  const warnings = Array.isArray(assignment.warnings) ? (assignment.warnings as string[]) : [];

  await prisma.$transaction(async (tx) => {
    await tx.courtAssignment.update({
      where: { id: assignment.id },
      data: {
        teamA: nextTeamA as unknown as object,
        teamB: nextTeamB as unknown as object,
        teamRatingA: Math.round(ratingA * 100) / 100,
        teamRatingB: Math.round(ratingB * 100) / 100,
        teamBalance: Math.round(Math.abs(ratingA - ratingB) * 100) / 100,
        skillSpread: Math.round(skillSpread * 100) / 100,
        reasons: [
          ...reasons,
          `Queue Master override: ${replacement.displayName} replaced ${replaced.displayName}`,
        ] as unknown as object,
        warnings: warnings as unknown as object,
      },
    });
    await tx.rotationRun.update({
      where: { id: rotation.id },
      data: { bench: nextBench as unknown as object, version: { increment: 1 } },
    });
    await writeAudit(tx, {
      clubId: access.session.clubId,
      sessionId,
      actorId,
      action: 'rotation.player_swapped',
      entityType: 'CourtAssignment',
      entityId: assignment.id,
      summary: `Rotation override: ${replacement.displayName} replaced ${replaced.displayName}`,
      metadata: {
        rotationId,
        playerParticipantId: replaced.userId,
        replacementParticipantId: replacement.userId,
        courtId: assignment.courtId,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });

  const refreshed = await prisma.rotationRun.findUniqueOrThrow({
    where: { id: rotation.id },
    include: { assignments: { include: { court: true }, orderBy: { createdAt: 'asc' } } },
  });
  publishSessionEvent({
    sessionId,
    publicId: access.session.publicId,
    type: 'rotation.proposed',
    version: access.session.version,
    payload: { rotationId, overridden: true },
  });
  return rotationDto(refreshed, refreshed.assignments, access.session.version);
}

export async function getLatestRotation(sessionId: string, actorId: string) {
  const access = await getSessionAccess(sessionId, actorId);
  await expirePreviews(sessionId);
  const preview = await prisma.rotationRun.findFirst({
    where: { sessionId, status: 'PREVIEW' },
    include: { assignments: { include: { court: true }, orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
  return preview ? rotationDto(preview, preview.assignments, access.session.version) : null;
}

export async function cancelPreview(
  sessionId: string,
  actorId: string,
  rotationId: string,
  meta: AuditMeta,
) {
  const access = await getSessionForAdmin(sessionId, actorId);
  const rotation = await prisma.rotationRun.findFirst({
    where: { id: rotationId, sessionId },
  });
  if (!rotation) throw AppError.notFound('Rotation preview not found');
  if (rotation.status !== 'PREVIEW') {
    throw AppError.conflict('Only a pending preview can be cancelled');
  }
  await prisma.$transaction([
    prisma.rotationRun.update({ where: { id: rotation.id }, data: { status: 'CANCELLED' } }),
    prisma.courtAssignment.updateMany({
      where: { rotationId: rotation.id, status: 'PROPOSED' },
      data: { status: 'CANCELLED' },
    }),
  ]);
  await writeAudit(prisma, {
    clubId: access.session.clubId,
    sessionId,
    actorId,
    action: 'rotation.cancelled',
    entityType: 'RotationRun',
    entityId: rotation.id,
    summary: 'Rotation preview cancelled',
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { cancelled: true };
}

const autoRotationChains = new Map<string, Promise<void>>();

/**
 * Automatic rotation is triggered once per completed match. Completing two
 * courts at the same instant previously produced two previews that cancelled
 * each other, leaving no new match. Serializing per session makes the second
 * trigger run against the committed state of the first.
 */
export function maybeAutoRotate(sessionId: string): Promise<void> {
  const previous = autoRotationChains.get(sessionId) ?? Promise.resolve();
  const run = previous.then(() => runAutoRotation(sessionId));
  autoRotationChains.set(sessionId, run);
  return run.finally(() => {
    if (autoRotationChains.get(sessionId) === run) autoRotationChains.delete(sessionId);
  });
}

async function runAutoRotation(sessionId: string): Promise<void> {
  try {
    const session = await prisma.playSession.findUnique({ where: { id: sessionId } });
    if (!session || session.status !== 'LIVE') return;
    const config = matchmakingConfigSchema.parse(session.matchmakingConfig);
    if (!config.autoAssign) return;
    const membership = await prisma.clubMembership.findUnique({
      where: { clubId_userId: { clubId: session.clubId, userId: session.createdById } },
      select: { status: true, role: true },
    });
    if (
      !membership ||
      membership.status !== 'ACTIVE' ||
      !['OWNER', 'QUEUE_MASTER'].includes(membership.role)
    ) {
      return;
    }

    const preview = await createPreview(sessionId, session.createdById);
    if (preview.assignments.length === 0) {
      await prisma.rotationRun.update({
        where: { id: preview.rotationId },
        data: { status: 'CANCELLED' },
      });
      return;
    }
    await commitRotation(
      sessionId,
      session.createdById,
      {
        rotationId: preview.rotationId,
        expectedSessionVersion: preview.sessionVersion,
        idempotencyKey: `auto-${preview.rotationId}`,
      },
      {},
    );
  } catch (error) {
    logger.warn({ err: error, sessionId }, 'Automatic rotation did not commit');
  }
}

export function defaultMatchmakingConfig(session: PlaySession): MatchmakingConfig {
  try {
    return matchmakingConfigSchema.parse(session.matchmakingConfig);
  } catch {
    return MATCHMAKING_DEFAULTS;
  }
}

export function defaultScoringConfig(session: PlaySession) {
  try {
    return scoringConfigSchema.parse(session.scoringConfig);
  } catch {
    return scoringConfigSchema.parse({});
  }
}

export function firstGame(match: Match): GameScore {
  const games = Array.isArray(match.games) ? (match.games as unknown as GameScore[]) : [];
  return games[games.length - 1] ?? { a: 0, b: 0 };
}

export const rotationActiveMatchStatuses = ACTIVE_MATCH_STATUSES;
