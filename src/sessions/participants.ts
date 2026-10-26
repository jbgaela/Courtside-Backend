import { Prisma, type SessionRegistration } from '@prisma/client';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';
import { writeAudit } from '../audit/audit.js';
import { publishSessionEvent } from '../realtime/gateway.js';
import {
  getSessionAccess,
  getSessionByCheckInToken,
  getSessionForPermission,
  hasSessionPermission,
} from './access.js';
import { guestParticipantDto, registrationDto } from './serializers.js';
import { countActiveGuests, countActiveParticipants } from './guests.js';
import type { Request } from 'express';
import { requestMetadata } from '../http/middleware/request-id.js';

interface AuditMeta {
  ip?: string;
  userAgent?: string;
}

async function activeParticipantCount(
  sessionId: string,
  tx?: Prisma.TransactionClient,
): Promise<number> {
  return countActiveParticipants(sessionId, tx);
}

const CAPACITY_RETRY_LIMIT = 6;

/**
 * MongoDB aborts a transaction that writes a document another transaction
 * committed after its snapshot. Registration retries then re-read the
 * participant count and either take the last slot or fail with "full".
 */
function isRetryableCapacityError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
    return true;
  }
  return error instanceof Error && /write conflict|deadlock/i.test(error.message);
}

async function pauseBeforeRetry(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
}

async function ensureClubMember(sessionClubId: string, userId: string) {
  const membership = await prisma.clubMembership.findUnique({
    where: { clubId_userId: { clubId: sessionClubId, userId } },
    include: { user: { select: { accountStatus: true } } },
  });
  if (!membership || membership.status !== 'ACTIVE' || membership.user.accountStatus !== 'ACTIVE') {
    throw AppError.forbidden('The player must be an active club member');
  }
}

export async function registerForSession(
  sessionId: string,
  userId: string,
  note: string | undefined,
  meta: AuditMeta,
) {
  const access = await getSessionAccess(sessionId, userId);
  const session = access.session;
  if (['DRAFT', 'COMPLETED', 'CANCELLED'].includes(session.status)) {
    throw AppError.conflict('Registration is not open for this session');
  }
  if (session.status === 'LIVE' && !session.allowLateArrivals) {
    throw AppError.conflict('Late registration is disabled for this session');
  }
  if (session.registrationPolicy === 'INVITE_ONLY') {
    throw AppError.forbidden('This session is invite-only. Ask a Queue Master to add you.');
  }

  const existing = await prisma.sessionRegistration.findUnique({
    where: { sessionId_userId: { sessionId, userId } },
  });
  if (existing && ['PENDING', 'REGISTERED', 'CHECKED_IN'].includes(existing.status)) {
    throw AppError.conflict('You are already registered for this session');
  }
  if ((await activeParticipantCount(sessionId)) >= session.capacity) {
    throw AppError.conflict('This session is full');
  }

  let committed: {
    registration: SessionRegistration;
    version: number;
  } | null = null;

  for (let attempt = 0; attempt < CAPACITY_RETRY_LIMIT && !committed; attempt += 1) {
    try {
      committed = await prisma.$transaction(async (tx) => {
        // Re-read the session inside the transaction: status, policy and
        // capacity are invariants of this write, not of the earlier request.
        const current = await tx.playSession.findUnique({ where: { id: sessionId } });
        if (!current) throw AppError.notFound('Session not found');
        if (['DRAFT', 'COMPLETED', 'CANCELLED'].includes(current.status)) {
          throw AppError.conflict('Registration is not open for this session');
        }
        if (current.status === 'LIVE' && !current.allowLateArrivals) {
          throw AppError.conflict('Late registration is disabled for this session');
        }
        if (current.registrationPolicy === 'INVITE_ONLY') {
          throw AppError.forbidden('This session is invite-only. Ask a Queue Master to add you.');
        }
        const status = current.registrationPolicy === 'APPROVAL' ? 'PENDING' : 'REGISTERED';

        const concurrent = await tx.sessionRegistration.findUnique({
          where: { sessionId_userId: { sessionId, userId } },
        });
        if (concurrent && ['PENDING', 'REGISTERED', 'CHECKED_IN'].includes(concurrent.status)) {
          throw AppError.conflict('You are already registered for this session');
        }
        if ((await activeParticipantCount(sessionId, tx)) >= current.capacity) {
          throw AppError.conflict('This session is full');
        }

        const registration = await tx.sessionRegistration.upsert({
          where: { sessionId_userId: { sessionId, userId } },
          update: {
            status,
            registeredAt: new Date(),
            respondedAt: null,
            approvedById: null,
            checkedInAt: null,
            checkInMethod: null,
            notes: note ?? null,
          },
          create: {
            sessionId,
            userId,
            status,
            notes: note ?? null,
          },
        });
        // The session version write is the capacity lock: concurrent
        // registrations for this session conflict, retry, and then observe
        // the new participant count instead of overbooking.
        const updatedSession = await tx.playSession.update({
          where: { id: sessionId },
          data: { version: { increment: 1 } },
          select: { version: true },
        });
        await writeAudit(tx, {
          clubId: current.clubId,
          sessionId,
          actorId: userId,
          action: status === 'PENDING' ? 'session.registration_requested' : 'session.registered',
          entityType: 'SessionRegistration',
          entityId: registration.id,
          summary: status === 'PENDING' ? 'Registration requested' : 'Registered for session',
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return { registration, version: updatedSession.version };
      });
    } catch (error) {
      if (isRetryableCapacityError(error) && attempt < CAPACITY_RETRY_LIMIT - 1) {
        await pauseBeforeRetry(attempt);
        continue;
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw AppError.conflict('You are already registered for this session');
      }
      throw error;
    }
  }

  if (!committed) {
    throw AppError.conflict('Registration is busy. Refresh and try again.');
  }

  publishSessionEvent({
    sessionId,
    publicId: session.publicId,
    type: 'queue.updated',
    version: committed.version,
  });
  return {
    id: committed.registration.id,
    status: committed.registration.status,
    version: committed.version,
  };
}

export async function cancelRegistration(
  sessionId: string,
  actorId: string,
  targetUserId: string | undefined,
  meta: AuditMeta,
) {
  const access = await getSessionAccess(sessionId, actorId);
  const isAdmin = hasSessionPermission(access, 'sessions.participants.manage');
  const userId = targetUserId ?? actorId;
  if (userId !== actorId && !isAdmin) {
    throw AppError.forbidden('You can only cancel your own registration');
  }
  if (['COMPLETED', 'CANCELLED'].includes(access.session.status)) {
    throw AppError.conflict('This session has ended');
  }
  const registration = await prisma.sessionRegistration.findUnique({
    where: { sessionId_userId: { sessionId, userId } },
  });
  if (!registration) throw AppError.notFound('Registration not found');
  const queue = await prisma.queueEntry.findUnique({
    where: { sessionId_participantId: { sessionId, participantId: userId } },
  });
  if (queue && ['PLAYING', 'RESERVED'].includes(queue.state)) {
    throw AppError.conflict('A player in an active match cannot be removed');
  }

  const version = await prisma.$transaction(async (tx) => {
    await tx.sessionRegistration.update({
      where: { id: registration.id },
      data: { status: 'WITHDRAWN', respondedAt: new Date() },
    });
    if (queue) {
      await tx.queueEntry.update({
        where: { id: queue.id },
        data: { state: 'LEFT', currentMatchId: null, version: { increment: 1 } },
      });
    }
    const updatedSession = await tx.playSession.update({
      where: { id: sessionId },
      data: { version: { increment: 1 } },
      select: { version: true },
    });
    await writeAudit(tx, {
      clubId: access.session.clubId,
      sessionId,
      actorId,
      action: isAdmin ? 'session.registration_removed' : 'session.registration_cancelled',
      entityType: 'SessionRegistration',
      entityId: registration.id,
      summary: isAdmin ? 'Queue Master removed a registration' : 'Registration cancelled',
      metadata: { targetUserId: userId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return updatedSession.version;
  });
  publishSessionEvent({
    sessionId,
    publicId: access.session.publicId,
    type: 'queue.updated',
    version,
  });
  return { cancelled: true, version };
}

export async function listRegistrations(sessionId: string, actorId: string) {
  const access = await getSessionForPermission(sessionId, actorId, 'sessions.checkin.manage');
  const [registrations, guests, queue] = await Promise.all([
    prisma.sessionRegistration.findMany({
      where: { sessionId },
      include: { user: { include: { profile: true } } },
      orderBy: [{ status: 'asc' }, { registeredAt: 'asc' }],
      take: 300,
    }),
    prisma.sessionGuest.findMany({
      where: { sessionId, status: 'ACTIVE' },
      orderBy: [{ displayName: 'asc' }, { createdAt: 'asc' }],
      take: 300,
    }),
    prisma.queueEntry.findMany({
      where: { sessionId },
      select: { participantId: true, state: true },
    }),
  ]);
  void access;
  const queueMap = new Map(queue.map((row) => [row.participantId, row.state]));
  const registeredRows = registrations.map((registration) =>
    registrationDto(registration, queueMap.get(registration.userId) ?? null),
  );
  const guestRows = guests.map((guest) =>
    guestParticipantDto(guest, queueMap.get(guest.id) ?? null),
  );
  const counts = registrations.reduce<Record<string, number>>((acc, registration) => {
    acc[registration.status] = (acc[registration.status] ?? 0) + 1;
    return acc;
  }, {});
  // Guests are active participants even though they do not have a registration
  // row. Keep the board's checked-in total aligned with the session and queue
  // counts; the separate `guests` key preserves the breakdown.
  counts.CHECKED_IN = (counts.CHECKED_IN ?? 0) + guestRows.length;
  counts.guests = guestRows.length;

  return {
    sessionId,
    registrations: registeredRows,
    guests: guestRows,
    participants: [...registeredRows, ...guestRows].sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    ),
    counts,
    capacity: access.session.capacity,
  };
}

export async function registrationAction(
  sessionId: string,
  actorId: string,
  registrationId: string,
  action: 'APPROVE' | 'REJECT' | 'NO_SHOW',
  reason: string | undefined,
  meta: AuditMeta,
) {
  const access = await getSessionForPermission(sessionId, actorId, 'sessions.checkin.manage');
  const registration = await prisma.sessionRegistration.findFirst({
    where: { id: registrationId, sessionId },
    include: { user: { include: { profile: true } } },
  });
  if (!registration) throw AppError.notFound('Registration not found');

  if (action === 'APPROVE') {
    if (registration.status !== 'PENDING') {
      throw AppError.conflict('Only pending registrations can be approved');
    }
    const activeIncludingTarget = await countActiveParticipants(sessionId);
    if (activeIncludingTarget - 1 >= access.session.capacity) {
      throw AppError.conflict('This session is full');
    }
  }

  const status = action === 'APPROVE' ? 'REGISTERED' : action === 'REJECT' ? 'REJECTED' : 'NO_SHOW';
  const queue = await prisma.queueEntry.findUnique({
    where: { sessionId_participantId: { sessionId, participantId: registration.userId } },
  });
  if (queue && ['PLAYING', 'RESERVED'].includes(queue.state) && action === 'NO_SHOW') {
    throw AppError.conflict('A player in an active match cannot be marked as a no-show');
  }

  const version = await prisma.$transaction(async (tx) => {
    await tx.sessionRegistration.update({
      where: { id: registration.id },
      data: {
        status,
        respondedAt: new Date(),
        ...(action === 'APPROVE' ? { approvedById: actorId } : {}),
      },
    });
    if ((action === 'REJECT' || action === 'NO_SHOW') && queue) {
      await tx.queueEntry.update({
        where: { id: queue.id },
        data: { state: 'LEFT', currentMatchId: null, version: { increment: 1 } },
      });
    }
    const updatedSession = await tx.playSession.update({
      where: { id: sessionId },
      data: { version: { increment: 1 } },
      select: { version: true },
    });
    await writeAudit(tx, {
      clubId: access.session.clubId,
      sessionId,
      actorId,
      action: `session.registration_${action.toLowerCase()}`,
      entityType: 'SessionRegistration',
      entityId: registration.id,
      summary: `${action.replace('_', ' ').toLowerCase()} for ${registration.user.profile?.displayName ?? registration.user.name}`,
      metadata: { reason: reason ?? null, targetUserId: registration.userId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return updatedSession.version;
  });
  publishSessionEvent({
    sessionId,
    publicId: access.session.publicId,
    type: 'queue.updated',
    version,
  });
  return { registrationId: registration.id, status, version };
}

export async function checkInPlayer(
  sessionId: string,
  actorId: string,
  input: { userId?: string; method?: string; reason?: string },
  meta: AuditMeta,
) {
  const access = await getSessionAccess(sessionId, actorId);
  const isAdmin = hasSessionPermission(access, 'sessions.checkin.manage');
  const targetUserId = input.userId ?? actorId;
  const isSelf = targetUserId === actorId;
  if (!isSelf && !isAdmin) throw AppError.forbidden('You can only check yourself in');
  if (['DRAFT', 'SCHEDULED', 'COMPLETED', 'CANCELLED'].includes(access.session.status)) {
    throw AppError.conflict('Check-in is not open for this session');
  }
  if (access.session.status === 'LIVE' && !access.session.allowLateArrivals) {
    throw AppError.conflict('Late check-in is disabled for this session');
  }
  if (
    isSelf &&
    !isAdmin &&
    (access.session.checkInPolicy === 'MANAGER' ||
      (access.session.checkInPolicy === 'SELF_AND_MANAGER' && input.method === 'MANAGER'))
  ) {
    throw AppError.forbidden('A Queue Master must check you in');
  }

  await ensureClubMember(access.session.clubId, targetUserId);

  const method = isAdmin ? 'MANAGER' : input.method === 'QR' ? 'QR' : 'SELF';
  const now = new Date();
  let result: {
    alreadyCheckedIn: boolean;
    registration: SessionRegistration & {
      user: {
        id: string;
        name: string;
        email: string;
        profile: { displayName: string; skillRating: number } | null;
      };
    };
    queue: { id: string; state: string; gamesPlayed: number; waitingSince: Date };
    version: number;
  } | null = null;

  for (let attempt = 0; attempt < CAPACITY_RETRY_LIMIT && !result; attempt += 1) {
    try {
      result = await prisma.$transaction(async (tx) => {
        const current = await tx.playSession.findUnique({ where: { id: sessionId } });
        if (!current) throw AppError.notFound('Session not found');
        if (['DRAFT', 'SCHEDULED', 'COMPLETED', 'CANCELLED'].includes(current.status)) {
          throw AppError.conflict('Check-in is not open for this session');
        }
        if (current.status === 'LIVE' && !current.allowLateArrivals) {
          throw AppError.conflict('Late check-in is disabled for this session');
        }

        let registration = await tx.sessionRegistration.findUnique({
          where: { sessionId_userId: { sessionId, userId: targetUserId } },
          include: { user: { include: { profile: true } } },
        });
        if (!registration) {
          if (!isAdmin) throw AppError.badRequest('Register for this session before checking in');
          if ((await activeParticipantCount(sessionId, tx)) >= current.capacity) {
            throw AppError.conflict('This session is full');
          }
          registration = await tx.sessionRegistration.create({
            data: {
              sessionId,
              userId: targetUserId,
              status: 'REGISTERED',
              approvedById: actorId,
              notes: input.reason ?? 'Walk-in added by Queue Master',
            },
            include: { user: { include: { profile: true } } },
          });
        }
        if (registration.status === 'PENDING') {
          throw AppError.conflict('This registration is awaiting Queue Master approval');
        }
        if (['REJECTED', 'NO_SHOW'].includes(registration.status)) {
          throw AppError.conflict('This registration cannot check in');
        }
        if (registration.status === 'WITHDRAWN' && !isAdmin) {
          throw AppError.conflict('This registration was withdrawn. Register again first.');
        }
        if (
          registration.status !== 'CHECKED_IN' &&
          registration.status !== 'REGISTERED' &&
          registration.status !== 'PENDING' &&
          (await activeParticipantCount(sessionId, tx)) >= current.capacity
        ) {
          throw AppError.conflict('This session is full');
        }

        const existingQueue = await tx.queueEntry.findUnique({
          where: { sessionId_participantId: { sessionId, participantId: targetUserId } },
        });
        if (
          registration.status === 'CHECKED_IN' &&
          existingQueue &&
          existingQueue.state !== 'LEFT'
        ) {
          return {
            alreadyCheckedIn: true,
            registration,
            queue: existingQueue,
            version: current.version,
          };
        }

        const updatedRegistration = await tx.sessionRegistration.update({
          where: { id: registration.id },
          data: {
            status: 'CHECKED_IN',
            checkedInAt: registration.checkedInAt ?? now,
            checkInMethod: method,
          },
          include: { user: { include: { profile: true } } },
        });
        const queue = await tx.queueEntry.upsert({
          where: { sessionId_participantId: { sessionId, participantId: targetUserId } },
          update: {
            state: 'WAITING',
            waitingSince: now,
            accumulatedWaitMs: 0,
            currentMatchId: null,
            pausedAt: null,
            restUntil: null,
            version: { increment: 1 },
          },
          create: {
            sessionId,
            participantId: targetUserId,
            participantType: 'REGISTERED',
            userId: targetUserId,
            state: 'WAITING',
            waitingSince: now,
            accumulatedWaitMs: 0,
          },
        });
        const session = await tx.playSession.update({
          where: { id: sessionId },
          data: { version: { increment: 1 } },
          select: { version: true },
        });
        await writeAudit(tx, {
          clubId: current.clubId,
          sessionId,
          actorId,
          action: isSelf ? 'checkin.self' : 'checkin.manager',
          entityType: 'QueueEntry',
          entityId: queue.id,
          summary: `${updatedRegistration.user.profile?.displayName ?? updatedRegistration.user.name} checked in`,
          metadata: { method, targetUserId, reason: input.reason ?? null, override: !isSelf },
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return {
          alreadyCheckedIn: false,
          registration: updatedRegistration,
          queue,
          version: session.version,
        };
      });
    } catch (error) {
      if (isRetryableCapacityError(error) && attempt < CAPACITY_RETRY_LIMIT - 1) {
        await pauseBeforeRetry(attempt);
        continue;
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        if (attempt < CAPACITY_RETRY_LIMIT - 1) {
          await pauseBeforeRetry(attempt);
          continue;
        }
        throw AppError.conflict('Check-in is already in progress. Refresh and try again.');
      }
      throw error;
    }
  }

  if (!result) {
    throw AppError.conflict('Check-in is busy. Refresh and try again.');
  }

  if (!result.alreadyCheckedIn) {
    publishSessionEvent({
      sessionId,
      publicId: access.session.publicId,
      type: 'queue.player_checked_in',
      version: result.version,
      payload: { userId: targetUserId },
      publicPayload: { checkedIn: true },
    });
  }
  return {
    alreadyCheckedIn: result.alreadyCheckedIn,
    registration: registrationDto(result.registration, result.queue.state),
    ...(result.alreadyCheckedIn
      ? {}
      : {
          queueEntry: {
            id: result.queue.id,
            state: result.queue.state,
            gamesPlayed: result.queue.gamesPlayed,
            waitingSince: result.queue.waitingSince.toISOString(),
          },
        }),
    version: result.version,
  };
}

export async function qrCheckIn(token: string, actorId: string, meta: AuditMeta) {
  const session = await getSessionByCheckInToken(token);
  return checkInPlayer(session.id, actorId, { method: 'QR' }, meta);
}

export async function queueSnapshot(sessionId: string, userId: string) {
  const access = await getSessionAccess(sessionId, userId);
  const [entries, registrations, activeCourts, guests] = await Promise.all([
    prisma.queueEntry.findMany({
      where: { sessionId, state: { not: 'LEFT' } },
      include: { user: { include: { profile: true } }, guest: true },
      orderBy: [{ gamesPlayed: 'asc' }, { waitingSince: 'asc' }],
    }),
    prisma.sessionRegistration.groupBy({
      by: ['status'],
      where: { sessionId },
      _count: { _all: true },
    }),
    prisma.sessionCourt.count({ where: { sessionId, active: true } }),
    countActiveGuests(sessionId),
  ]);

  const stateOrder: Record<string, number> = {
    WAITING: 0,
    RESTING: 1,
    PLAYING: 2,
    RESERVED: 3,
    PAUSED: 4,
  };
  const sorted = [...entries].sort((a, b) => {
    const state = (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9);
    if (state !== 0) return state;
    if (a.gamesPlayed !== b.gamesPlayed) return a.gamesPlayed - b.gamesPlayed;
    return a.waitingSince.getTime() - b.waitingSince.getTime();
  });

  const now = Date.now();
  let waitingPosition = 0;
  const slotsPerRound = Math.max(1, activeCourts * (access.session.format === 'SINGLES' ? 2 : 4));
  const queue = sorted.map((entry) => {
    const waitingMinutes = Math.max(0, Math.round((now - entry.waitingSince.getTime()) / 60_000));
    if (entry.state === 'WAITING') waitingPosition += 1;
    const guest = entry.guest;
    const displayName = guest
      ? guest.displayName
      : (entry.user?.profile?.displayName ?? entry.user?.name ?? 'Unknown player');
    const skillRating = guest ? guest.skillRating : (entry.user?.profile?.skillRating ?? 3);
    return {
      id: entry.id,
      participantId: entry.participantId,
      participantType: entry.participantType,
      userId: entry.userId,
      guestId: entry.guestId,
      gender: guest?.gender ?? null,
      displayName,
      skillRating,
      state: entry.state,
      gamesPlayed: entry.gamesPlayed,
      wins: entry.wins,
      losses: entry.losses,
      waitingMinutes,
      position: entry.state === 'WAITING' ? waitingPosition : null,
      estimatedWaitMinutes:
        entry.state === 'WAITING'
          ? Math.max(0, Math.ceil((waitingPosition - 1) / slotsPerRound) * 12)
          : null,
      currentMatchId: entry.currentMatchId,
      restUntil: entry.restUntil?.toISOString() ?? null,
      joinedAt: entry.joinedAt.toISOString(),
    };
  });
  const registrationCounts = registrations.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = row._count._all;
    return acc;
  }, {});

  return {
    sessionId,
    status: access.session.status,
    version: access.session.version,
    format: access.session.format,
    courts: activeCourts,
    counts: {
      checkedIn: (registrationCounts.CHECKED_IN ?? 0) + guests,
      registered: registrationCounts.REGISTERED ?? 0,
      pending: registrationCounts.PENDING ?? 0,
      guests,
      waiting: queue.filter((entry) => entry.state === 'WAITING').length,
      playing: queue.filter((entry) => entry.state === 'PLAYING').length,
      paused: queue.filter((entry) => entry.state === 'PAUSED').length,
    },
    queue,
    self: queue.find((entry) => entry.participantId === userId) ?? null,
    viewerRole: access.membership.role,
  };
}

export async function setQueuePaused(
  sessionId: string,
  actorId: string,
  input: { userId?: string; participantId?: string; reason?: string },
  paused: boolean,
  meta: AuditMeta,
) {
  const access = await getSessionAccess(sessionId, actorId);
  const isAdmin = hasSessionPermission(access, 'queue.manage');
  const targetParticipantId = input.participantId ?? input.userId ?? actorId;
  if (targetParticipantId !== actorId && !isAdmin) {
    throw AppError.forbidden('You can only change your own queue state');
  }
  if (['COMPLETED', 'CANCELLED', 'DRAFT'].includes(access.session.status)) {
    throw AppError.conflict('The queue is not active');
  }
  const entry = await prisma.queueEntry.findUnique({
    where: { sessionId_participantId: { sessionId, participantId: targetParticipantId } },
    include: { user: { include: { profile: true } }, guest: true },
  });
  if (!entry) throw AppError.notFound('Queue entry not found');
  if (['PLAYING', 'RESERVED', 'LEFT'].includes(entry.state)) {
    throw AppError.conflict('A player in an active match or who left cannot be paused');
  }
  if (paused && entry.state === 'PAUSED') {
    return { state: entry.state, version: access.session.version };
  }
  if (!paused && entry.state !== 'PAUSED') {
    throw AppError.conflict('This player is not paused');
  }

  const now = new Date();
  const accumulated =
    paused && entry.pausedAt === null
      ? entry.accumulatedWaitMs + Math.max(0, now.getTime() - entry.waitingSince.getTime())
      : entry.accumulatedWaitMs;
  const state = paused ? 'PAUSED' : 'WAITING';
  const version = await prisma.$transaction(async (tx) => {
    await tx.queueEntry.update({
      where: { id: entry.id },
      data: {
        state,
        pausedAt: paused ? now : null,
        accumulatedWaitMs: accumulated,
        waitingSince: paused ? entry.waitingSince : new Date(now.getTime() - accumulated),
        version: { increment: 1 },
      },
    });
    const session = await tx.playSession.update({
      where: { id: sessionId },
      data: { version: { increment: 1 } },
      select: { version: true },
    });
    await writeAudit(tx, {
      clubId: access.session.clubId,
      sessionId,
      actorId,
      action: paused ? 'queue.paused' : 'queue.resumed',
      entityType: 'QueueEntry',
      entityId: entry.id,
      summary: `${entry.guest?.displayName ?? entry.user?.profile?.displayName ?? entry.user?.name ?? 'Player'} ${paused ? 'paused' : 'resumed'} queue participation`,
      metadata: {
        targetParticipantId,
        participantType: entry.participantType,
        targetUserId: entry.userId,
        guestId: entry.guestId,
        override: targetParticipantId !== actorId,
        reason: input.reason ?? null,
        accumulatedWaitMs: accumulated,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return session.version;
  });
  publishSessionEvent({
    sessionId,
    publicId: access.session.publicId,
    type: 'queue.availability_changed',
    version,
    payload: {
      participantId: targetParticipantId,
      userId: entry.userId,
      guestId: entry.guestId,
      state,
    },
  });
  return { state, version };
}

export async function leaveSession(
  sessionId: string,
  actorId: string,
  input: { userId?: string; participantId?: string; reason?: string },
  meta: AuditMeta,
) {
  const access = await getSessionAccess(sessionId, actorId);
  const isAdmin = hasSessionPermission(access, 'queue.manage');
  const targetParticipantId = input.participantId ?? input.userId ?? actorId;
  if (targetParticipantId !== actorId && !isAdmin) {
    throw AppError.forbidden('You can only leave for yourself');
  }
  const entry = await prisma.queueEntry.findUnique({
    where: { sessionId_participantId: { sessionId, participantId: targetParticipantId } },
    include: { user: { include: { profile: true } }, guest: true },
  });
  if (!entry) throw AppError.notFound('Queue entry not found');
  if (['PLAYING', 'RESERVED'].includes(entry.state)) {
    throw AppError.conflict('Finish the active match before leaving the session');
  }
  const version = await prisma.$transaction(async (tx) => {
    await tx.queueEntry.update({
      where: { id: entry.id },
      data: { state: 'LEFT', currentMatchId: null, version: { increment: 1 } },
    });
    if (entry.userId) {
      await tx.sessionRegistration.updateMany({
        where: { sessionId, userId: entry.userId },
        data: { status: 'WITHDRAWN' },
      });
    }
    if (entry.guestId) {
      await tx.sessionGuest.updateMany({
        where: { id: entry.guestId, sessionId, status: 'ACTIVE' },
        data: { status: 'REMOVED', removedAt: new Date(), version: { increment: 1 } },
      });
    }
    const session = await tx.playSession.update({
      where: { id: sessionId },
      data: { version: { increment: 1 } },
      select: { version: true },
    });
    await writeAudit(tx, {
      clubId: access.session.clubId,
      sessionId,
      actorId,
      action: isAdmin ? 'queue.player_removed' : 'queue.left',
      entityType: 'QueueEntry',
      entityId: entry.id,
      summary: `${entry.guest?.displayName ?? entry.user?.profile?.displayName ?? entry.user?.name ?? 'Player'} left the session`,
      metadata: {
        targetParticipantId,
        participantType: entry.participantType,
        targetUserId: entry.userId,
        guestId: entry.guestId,
        reason: input.reason ?? null,
        override: targetParticipantId !== actorId,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return session.version;
  });
  publishSessionEvent({
    sessionId,
    publicId: access.session.publicId,
    type: 'queue.updated',
    version,
    payload: {
      participantId: targetParticipantId,
      userId: entry.userId,
      guestId: entry.guestId,
    },
  });
  return { left: true, version };
}

export function auditMetaFromRequest(req: Request): AuditMeta {
  return requestMetadata(req);
}

export function handleUniqueRegistration(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw AppError.conflict('A registration or queue entry already exists');
  }
  throw error;
}
