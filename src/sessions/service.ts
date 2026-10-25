import {
  matchmakingConfigSchema,
  scoringConfigSchema,
  SESSION_TRANSITIONS,
  type SessionStatus,
  type MatchmakingConfig,
  type ScoringConfig,
} from '@picklequeue/contracts';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';
import { env } from '../config/env.js';
import { generatePublicId, randomToken } from '../security/tokens.js';
import { writeAudit } from '../audit/audit.js';
import { getClubAccess, getClubForAdmin } from '../clubs/access.js';
import { getSessionAccess, getSessionForAdmin } from './access.js';
import { sessionDto } from './serializers.js';
import { publishSessionEvent } from '../realtime/gateway.js';

interface AuditMeta {
  ip?: string;
  userAgent?: string;
}

interface SessionCounts {
  registered: number;
  checkedIn: number;
  waiting: number;
  playing: number;
  pending: number;
  courts: number;
}

async function countsForSession(sessionId: string): Promise<SessionCounts> {
  const [registrations, queue, courts] = await Promise.all([
    prisma.sessionRegistration.groupBy({
      by: ['status'],
      where: { sessionId },
      _count: { _all: true },
    }),
    prisma.queueEntry.groupBy({
      by: ['state'],
      where: { sessionId },
      _count: { _all: true },
    }),
    prisma.sessionCourt.count({ where: { sessionId, active: true } }),
  ]);
  const regMap = new Map(registrations.map((row) => [row.status, row._count._all]));
  const queueMap = new Map(queue.map((row) => [row.state, row._count._all]));
  return {
    registered: regMap.get('REGISTERED') ?? 0,
    checkedIn: regMap.get('CHECKED_IN') ?? 0,
    pending: regMap.get('PENDING') ?? 0,
    waiting: queueMap.get('WAITING') ?? 0,
    playing: queueMap.get('PLAYING') ?? 0,
    courts,
  };
}

async function sessionCourts(sessionId: string) {
  const rows = await prisma.sessionCourt.findMany({
    where: { sessionId, active: true },
    include: { court: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map((row) => ({
    id: row.court.id,
    name: row.court.name,
    status: row.court.status,
    sortOrder: row.sortOrder,
  }));
}

async function ensureCourtsBelongToClub(clubId: string, courtIds: string[]) {
  const courts = await prisma.court.findMany({
    where: { clubId, id: { in: courtIds } },
    select: { id: true, name: true, status: true },
  });
  if (courts.length !== courtIds.length) {
    throw AppError.badRequest('One or more courts do not belong to this club');
  }
  const unusable = courts.filter(
    (court) => court.status === 'INACTIVE' || court.status === 'MAINTENANCE',
  );
  if (unusable.length > 0) {
    throw AppError.badRequest(
      `Courts are not available: ${unusable.map((court) => court.name).join(', ')}`,
    );
  }
  return courts;
}

export async function createSession(
  clubId: string,
  actorId: string,
  input: {
    name: string;
    description?: string;
    venue?: string;
    startsAt: string;
    endsAt: string;
    timezone: string;
    capacity: number;
    format: string;
    registrationPolicy: string;
    checkInPolicy: string;
    published: boolean;
    allowLateArrivals: boolean;
    courtIds: string[];
    matchmaking?: unknown;
    scoring?: unknown;
  },
  meta: AuditMeta,
) {
  await getClubForAdmin(clubId, actorId);
  await ensureCourtsBelongToClub(clubId, input.courtIds);

  const matchmaking = matchmakingConfigSchema.parse(input.matchmaking ?? {});
  matchmaking.format = input.format === 'SINGLES' ? 'SINGLES' : 'DOUBLES';
  const scoring = scoringConfigSchema.parse(input.scoring ?? {});

  const session = await prisma.$transaction(async (tx) => {
    const created = await tx.playSession.create({
      data: {
        clubId,
        publicId: generatePublicId('s'),
        checkInToken: randomToken(24),
        name: input.name,
        description: input.description ?? null,
        venue: input.venue ?? null,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        timezone: input.timezone,
        status: 'DRAFT',
        capacity: input.capacity,
        format: matchmaking.format,
        registrationPolicy: input.registrationPolicy,
        checkInPolicy: input.checkInPolicy,
        published: false,
        allowLateArrivals: input.allowLateArrivals,
        matchmakingConfig: matchmaking as unknown as object,
        scoringConfig: scoring as unknown as object,
        createdById: actorId,
        sessionCourts: {
          create: input.courtIds.map((courtId, index) => ({
            courtId,
            active: true,
            sortOrder: index,
          })),
        },
      },
    });
    await writeAudit(tx, {
      clubId,
      sessionId: created.id,
      actorId,
      action: 'session.created',
      entityType: 'PlaySession',
      entityId: created.id,
      summary: `Session “${created.name}” created`,
      metadata: { courtIds: input.courtIds, format: created.format },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return created;
  });

  if (input.published) {
    await transitionSession(session.id, actorId, { status: 'SCHEDULED', force: false }, meta);
    return publishSession(session.id, actorId, true, meta);
  }
  return getSessionDetail(session.id, actorId);
}

export async function listSessions(
  clubId: string,
  userId: string,
  query: { status?: string; limit: number },
) {
  const access = await getClubAccess(clubId, userId);
  const isAdmin = access.membership.role === 'OWNER' || access.membership.role === 'QUEUE_MASTER';
  const sessions = await prisma.playSession.findMany({
    where: {
      clubId,
      ...(query.status ? { status: query.status } : {}),
      ...(isAdmin ? {} : { published: true, status: { not: 'DRAFT' } }),
    },
    orderBy: { startsAt: 'desc' },
    take: query.limit,
  });

  const ids = sessions.map((session) => session.id);
  if (ids.length === 0) return [];

  const [registrations, queue, courts, viewerRegistrations, viewerQueue] = await Promise.all([
    prisma.sessionRegistration.groupBy({
      by: ['sessionId', 'status'],
      where: { sessionId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.queueEntry.groupBy({
      by: ['sessionId', 'state'],
      where: { sessionId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.sessionCourt.findMany({
      where: { sessionId: { in: ids }, active: true },
      include: { court: true },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.sessionRegistration.findMany({
      where: { sessionId: { in: ids }, userId },
    }),
    prisma.queueEntry.findMany({
      where: { sessionId: { in: ids }, userId },
    }),
  ]);

  const regCount = new Map<string, number>();
  const checkedCount = new Map<string, number>();
  const waitingCount = new Map<string, number>();
  const playingCount = new Map<string, number>();
  const pendingCount = new Map<string, number>();
  for (const row of registrations) {
    const key = row.sessionId;
    if (row.status === 'REGISTERED') regCount.set(key, row._count._all);
    if (row.status === 'CHECKED_IN') checkedCount.set(key, row._count._all);
    if (row.status === 'PENDING') pendingCount.set(key, row._count._all);
  }
  for (const row of queue) {
    if (row.state === 'WAITING' || row.state === 'RESTING') {
      waitingCount.set(row.sessionId, (waitingCount.get(row.sessionId) ?? 0) + row._count._all);
    }
    if (row.state === 'PLAYING') playingCount.set(row.sessionId, row._count._all);
  }
  const courtMap = new Map<
    string,
    Array<{ id: string; name: string; status: string; sortOrder: number }>
  >();
  for (const row of courts) {
    const list = courtMap.get(row.sessionId) ?? [];
    list.push({
      id: row.court.id,
      name: row.court.name,
      status: row.court.status,
      sortOrder: row.sortOrder,
    });
    courtMap.set(row.sessionId, list);
  }
  const regMap = new Map(viewerRegistrations.map((row) => [row.sessionId, row]));
  const queueMap = new Map(viewerQueue.map((row) => [row.sessionId, row]));

  return sessions.map((session) =>
    sessionDto(
      session,
      {
        role: access.membership.role,
        registration: regMap.get(session.id) ?? null,
        queueState: queueMap.get(session.id)?.state ?? null,
      },
      {
        counts: {
          registered: regCount.get(session.id) ?? 0,
          checkedIn: checkedCount.get(session.id) ?? 0,
          waiting: waitingCount.get(session.id) ?? 0,
          playing: playingCount.get(session.id) ?? 0,
          pending: pendingCount.get(session.id) ?? 0,
          courts: courtMap.get(session.id)?.length ?? 0,
        },
        courts: courtMap.get(session.id) ?? [],
      },
    ),
  );
}

export async function getSessionDetail(sessionId: string, userId: string) {
  const access = await getSessionAccess(sessionId, userId);
  const [counts, courts, registration, queue] = await Promise.all([
    countsForSession(sessionId),
    sessionCourts(sessionId),
    prisma.sessionRegistration.findUnique({
      where: { sessionId_userId: { sessionId, userId } },
    }),
    prisma.queueEntry.findUnique({
      where: { sessionId_userId: { sessionId, userId } },
    }),
  ]);
  return sessionDto(
    access.session,
    {
      role: access.membership.role,
      registration,
      queueState: queue?.state ?? null,
    },
    { counts, courts },
  );
}

export async function updateSession(
  sessionId: string,
  actorId: string,
  input: {
    name?: string;
    description?: string | null;
    venue?: string | null;
    startsAt?: string;
    endsAt?: string;
    timezone?: string;
    capacity?: number;
    format?: string;
    registrationPolicy?: string;
    checkInPolicy?: string;
    allowLateArrivals?: boolean;
    courtIds?: string[];
    matchmaking?: unknown;
    scoring?: unknown;
    expectedVersion: number;
  },
  meta: AuditMeta,
) {
  const access = await getSessionForAdmin(sessionId, actorId);
  const session = access.session;
  if (['LIVE', 'COMPLETED', 'CANCELLED'].includes(session.status)) {
    throw AppError.conflict('Session configuration cannot be changed after the session starts');
  }
  if (input.courtIds) await ensureCourtsBelongToClub(session.clubId, input.courtIds);

  const startsAt = input.startsAt ? new Date(input.startsAt) : session.startsAt;
  const endsAt = input.endsAt ? new Date(input.endsAt) : session.endsAt;
  if (endsAt <= startsAt) throw AppError.badRequest('End time must be after start time');

  if (input.capacity !== undefined) {
    const active = await prisma.sessionRegistration.count({
      where: { sessionId, status: { in: ['PENDING', 'REGISTERED', 'CHECKED_IN'] } },
    });
    if (input.capacity < active) {
      throw AppError.conflict(`Capacity cannot be below the ${active} current registrations`);
    }
  }

  const existingMatchmaking = session.matchmakingConfig as unknown as MatchmakingConfig;
  const existingScoring = session.scoringConfig as unknown as ScoringConfig;
  const matchmaking = matchmakingConfigSchema.parse({
    ...existingMatchmaking,
    ...(input.matchmaking && typeof input.matchmaking === 'object' ? input.matchmaking : {}),
  });
  if (input.format) matchmaking.format = input.format === 'SINGLES' ? 'SINGLES' : 'DOUBLES';
  const scoring = scoringConfigSchema.parse({
    ...existingScoring,
    ...(input.scoring && typeof input.scoring === 'object' ? input.scoring : {}),
  });

  await prisma.$transaction(async (tx) => {
    const updated = await tx.playSession.updateMany({
      where: { id: sessionId, version: input.expectedVersion },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.venue !== undefined ? { venue: input.venue } : {}),
        ...(input.startsAt !== undefined ? { startsAt } : {}),
        ...(input.endsAt !== undefined ? { endsAt } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
        ...(input.format !== undefined ? { format: matchmaking.format } : {}),
        ...(input.registrationPolicy !== undefined
          ? { registrationPolicy: input.registrationPolicy }
          : {}),
        ...(input.checkInPolicy !== undefined ? { checkInPolicy: input.checkInPolicy } : {}),
        ...(input.allowLateArrivals !== undefined
          ? { allowLateArrivals: input.allowLateArrivals }
          : {}),
        matchmakingConfig: matchmaking as unknown as object,
        scoringConfig: scoring as unknown as object,
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) {
      throw AppError.conflict('This session was changed by someone else. Refresh and try again.');
    }
    if (input.courtIds) {
      await tx.sessionCourt.updateMany({ where: { sessionId }, data: { active: false } });
      for (const [index, courtId] of input.courtIds.entries()) {
        await tx.sessionCourt.upsert({
          where: { sessionId_courtId: { sessionId, courtId } },
          update: { active: true, sortOrder: index },
          create: { sessionId, courtId, active: true, sortOrder: index },
        });
      }
    }
    await writeAudit(tx, {
      clubId: session.clubId,
      sessionId,
      actorId,
      action: 'session.updated',
      entityType: 'PlaySession',
      entityId: sessionId,
      summary: 'Session configuration updated',
      metadata: { ...input, expectedVersion: undefined } as unknown as object,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });

  return getSessionDetail(sessionId, actorId);
}

export async function updateSessionCourts(
  sessionId: string,
  actorId: string,
  input: { courtIds: string[]; expectedVersion?: number },
  meta: AuditMeta,
) {
  const access = await getSessionForAdmin(sessionId, actorId);
  if (['LIVE', 'COMPLETED', 'CANCELLED'].includes(access.session.status)) {
    throw AppError.conflict('Courts cannot be changed after the session starts');
  }
  await ensureCourtsBelongToClub(access.session.clubId, input.courtIds);
  await prisma.$transaction(async (tx) => {
    if (input.expectedVersion !== undefined) {
      const updated = await tx.playSession.updateMany({
        where: { id: sessionId, version: input.expectedVersion },
        data: { version: { increment: 1 } },
      });
      if (updated.count === 0) throw AppError.conflict('Session changed; refresh and try again');
    } else {
      await tx.playSession.update({
        where: { id: sessionId },
        data: { version: { increment: 1 } },
      });
    }
    await tx.sessionCourt.updateMany({ where: { sessionId }, data: { active: false } });
    for (const [index, courtId] of input.courtIds.entries()) {
      await tx.sessionCourt.upsert({
        where: { sessionId_courtId: { sessionId, courtId } },
        update: { active: true, sortOrder: index },
        create: { sessionId, courtId, active: true, sortOrder: index },
      });
    }
    await writeAudit(tx, {
      clubId: access.session.clubId,
      sessionId,
      actorId,
      action: 'session.courts_updated',
      entityType: 'PlaySession',
      entityId: sessionId,
      summary: 'Session courts updated',
      metadata: { courtIds: input.courtIds },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  return getSessionDetail(sessionId, actorId);
}

export async function transitionSession(
  sessionId: string,
  actorId: string,
  input: { status: SessionStatus; reason?: string; force: boolean; expectedVersion?: number },
  meta: AuditMeta,
) {
  const access = await getSessionForAdmin(sessionId, actorId);
  const session = access.session;
  const current = session.status as SessionStatus;
  if (current === input.status) {
    return getSessionDetail(sessionId, actorId);
  }
  if (!SESSION_TRANSITIONS[current].includes(input.status)) {
    throw AppError.conflict(`Cannot move a session from ${current} to ${input.status}`);
  }

  const now = new Date();
  let activeMatches: number | null = null;

  if (input.status === 'SCHEDULED') {
    const activeCourts = await prisma.sessionCourt.count({ where: { sessionId, active: true } });
    if (activeCourts === 0)
      throw AppError.badRequest('Select at least one court before scheduling');
  }

  if (input.status === 'LIVE') {
    const checkedIn = await prisma.sessionRegistration.count({
      where: { sessionId, status: 'CHECKED_IN' },
    });
    const minimum = session.format === 'SINGLES' ? 2 : 4;
    if (checkedIn < minimum) {
      throw AppError.conflict(`At least ${minimum} checked-in players are required to go live`);
    }
    const activeCourts = await prisma.sessionCourt.count({ where: { sessionId, active: true } });
    if (activeCourts === 0) throw AppError.badRequest('The session has no active courts');
  }

  if (input.status === 'COMPLETED') {
    activeMatches = await prisma.match.count({
      where: { sessionId, status: { in: ['READY', 'IN_PROGRESS', 'RESERVED'] } },
    });
    if (activeMatches > 0) {
      throw AppError.conflict('Finish or cancel all active matches before completing the session');
    }
  }

  if (input.status === 'CANCELLED') {
    activeMatches = await prisma.match.count({
      where: { sessionId, status: { in: ['READY', 'IN_PROGRESS', 'RESERVED', 'PROPOSED'] } },
    });
    if (activeMatches > 0 && !input.force) {
      throw AppError.conflict('Active matches exist. Use force to cancel them explicitly.');
    }
  }

  const occupiedCourtIds =
    input.status === 'CANCELLED'
      ? (
          await prisma.match.findMany({
            where: {
              sessionId,
              status: { in: ['PROPOSED', 'RESERVED', 'READY', 'IN_PROGRESS'] },
            },
            select: { courtId: true },
          })
        ).map((match) => match.courtId)
      : [];

  const newVersion = await prisma.$transaction(async (tx) => {
    const updated = await tx.playSession.updateMany({
      where: {
        id: sessionId,
        version: input.expectedVersion ?? session.version,
      },
      data: {
        status: input.status,
        version: { increment: 1 },
        ...(input.status === 'CHECK_IN_OPEN' ? { checkInOpensAt: now } : {}),
        ...(input.status === 'LIVE' ? { startedAt: now } : {}),
        ...(input.status === 'COMPLETED' ? { completedAt: now } : {}),
        ...(input.status === 'CANCELLED'
          ? { cancelledAt: now, cancelReason: input.reason ?? 'Cancelled by administrator' }
          : {}),
      },
    });
    if (updated.count === 0) throw AppError.conflict('Session changed; refresh and try again');

    if (input.status === 'LIVE') {
      await tx.queueEntry.updateMany({
        where: { sessionId, state: { in: ['WAITING', 'RESTING'] } },
        data: { state: 'WAITING' },
      });
    }

    if (input.status === 'COMPLETED') {
      await tx.queueEntry.updateMany({
        where: { sessionId, state: { in: ['WAITING', 'RESTING', 'PAUSED'] } },
        data: { state: 'LEFT' },
      });
    }

    if (input.status === 'CANCELLED') {
      await tx.match.updateMany({
        where: { sessionId, status: { in: ['PROPOSED', 'RESERVED', 'READY', 'IN_PROGRESS'] } },
        data: { status: 'CANCELLED' },
      });
      await tx.courtAssignment.updateMany({
        where: { sessionId, status: { in: ['PROPOSED', 'ACTIVE'] } },
        data: { status: 'CANCELLED' },
      });
      await tx.rotationRun.updateMany({
        where: { sessionId, status: 'PREVIEW' },
        data: { status: 'CANCELLED' },
      });
      await tx.queueEntry.updateMany({
        where: { sessionId, state: { not: 'LEFT' } },
        data: { state: 'LEFT', currentMatchId: null },
      });
      if (occupiedCourtIds.length > 0) {
        await tx.court.updateMany({
          where: { id: { in: occupiedCourtIds } },
          data: { status: 'AVAILABLE' },
        });
      }
      await tx.sessionRegistration.updateMany({
        where: { sessionId, status: { in: ['PENDING', 'REGISTERED', 'CHECKED_IN'] } },
        data: { status: 'WITHDRAWN' },
      });
    }

    await writeAudit(tx, {
      clubId: session.clubId,
      sessionId,
      actorId,
      action: `session.status_${input.status.toLowerCase()}`,
      entityType: 'PlaySession',
      entityId: sessionId,
      summary: `Session moved from ${current} to ${input.status}`,
      metadata: {
        previousStatus: current,
        newStatus: input.status,
        reason: input.reason ?? null,
        forced: input.force,
        cancelledMatches: activeMatches ?? 0,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return session.version + 1;
  });

  publishSessionEvent({
    sessionId,
    publicId: session.publicId,
    type: 'session.status_changed',
    version: newVersion,
    payload: { status: input.status },
    publicPayload: { status: input.status },
  });

  return getSessionDetail(sessionId, actorId);
}

export async function publishSession(
  sessionId: string,
  actorId: string,
  published: boolean,
  meta: AuditMeta,
) {
  const access = await getSessionForAdmin(sessionId, actorId);
  if (published && access.session.status === 'DRAFT') {
    throw AppError.conflict('Schedule the session before publishing it');
  }
  const updated = await prisma.playSession.update({
    where: { id: sessionId },
    data: { published, version: { increment: 1 } },
  });
  await writeAudit(prisma, {
    clubId: access.session.clubId,
    sessionId,
    actorId,
    action: published ? 'session.published' : 'session.unpublished',
    entityType: 'PlaySession',
    entityId: sessionId,
    summary: published ? 'Public link enabled' : 'Public link disabled',
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  publishSessionEvent({
    sessionId,
    publicId: access.session.publicId,
    type: 'session.publication_changed',
    version: updated.version,
    payload: { published },
  });
  return getSessionDetail(sessionId, actorId);
}

export async function getSessionPublicLink(sessionId: string, userId: string) {
  const access = await getSessionForAdmin(sessionId, userId);
  return {
    publicId: access.session.publicId,
    published: access.session.published,
    publicUrl: `${env.FRONTEND_ORIGIN.split(',')[0] ?? ''}/public/sessions/${access.session.publicId}`,
    checkInToken: access.session.checkInToken,
    checkInUrl: `${env.FRONTEND_ORIGIN.split(',')[0] ?? ''}/check-in/${access.session.checkInToken}`,
  };
}

export async function cancelPreviewIfExpired(sessionId: string) {
  await prisma.rotationRun.updateMany({
    where: { sessionId, status: 'PREVIEW', expiresAt: { lt: new Date() } },
    data: { status: 'EXPIRED' },
  });
}
