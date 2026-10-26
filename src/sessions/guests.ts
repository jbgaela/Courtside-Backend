import { Prisma } from '@prisma/client';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';
import { writeAudit } from '../audit/audit.js';
import { publishSessionEvent } from '../realtime/gateway.js';
import { getSessionForPermission } from './access.js';
import { guestDto } from './serializers.js';

interface AuditMeta {
  ip?: string;
  userAgent?: string;
}

const OPEN_STATUSES = ['CHECK_IN_OPEN', 'LIVE'];
const ENDED_STATUSES = ['COMPLETED', 'CANCELLED'];
const ACTIVE_MATCH_STATES = ['PLAYING', 'RESERVED'];

export async function countActiveGuests(
  sessionId: string,
  tx?: Prisma.TransactionClient,
): Promise<number> {
  const client = tx ?? prisma;
  return client.sessionGuest.count({ where: { sessionId, status: 'ACTIVE' } });
}

/**
 * Capacity is shared by registered players and guests. Guests bypass player
 * registration, but they are still participants in the session.
 */
export async function countActiveParticipants(
  sessionId: string,
  tx?: Prisma.TransactionClient,
): Promise<number> {
  const client = tx ?? prisma;
  const [registrations, guests] = await Promise.all([
    client.sessionRegistration.count({
      where: { sessionId, status: { in: ['PENDING', 'REGISTERED', 'CHECKED_IN'] } },
    }),
    client.sessionGuest.count({ where: { sessionId, status: 'ACTIVE' } }),
  ]);
  return registrations + guests;
}

function assertGuestWindow(session: { status: string; allowLateArrivals: boolean }): void {
  if (!OPEN_STATUSES.includes(session.status)) {
    throw AppError.conflict(
      'Guests can only be added while check-in is open or the session is live',
    );
  }
  if (session.status === 'LIVE' && !session.allowLateArrivals) {
    throw AppError.conflict('Late arrivals are disabled for this session');
  }
}

function assertSessionNotEnded(session: { status: string }): void {
  if (ENDED_STATUSES.includes(session.status)) {
    throw AppError.conflict('This session has ended');
  }
}

async function findGuest(sessionId: string, guestId: string) {
  const guest = await prisma.sessionGuest.findFirst({
    where: { id: guestId, sessionId },
  });
  if (!guest) throw AppError.notFound('Guest player not found');
  return guest;
}

async function findQueueEntry(sessionId: string, participantId: string) {
  return prisma.queueEntry.findUnique({
    where: { sessionId_participantId: { sessionId, participantId } },
  });
}

export async function createGuest(
  sessionId: string,
  actorId: string,
  input: { displayName: string; gender: string; skillRating: number; addToQueue: boolean },
  meta: AuditMeta,
) {
  const access = await getSessionForPermission(sessionId, actorId, 'sessions.guests.manage');
  assertGuestWindow(access.session);

  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const active = await countActiveParticipants(sessionId, tx);
    if (active >= access.session.capacity) {
      throw AppError.conflict('This session is full');
    }

    const guest = await tx.sessionGuest.create({
      data: {
        sessionId,
        clubId: access.session.clubId,
        displayName: input.displayName,
        gender: input.gender,
        skillRating: input.skillRating,
        createdById: actorId,
      },
    });

    const queueEntry = input.addToQueue
      ? await tx.queueEntry.create({
          data: {
            sessionId,
            participantId: guest.id,
            participantType: 'GUEST',
            guestId: guest.id,
            state: 'WAITING',
            waitingSince: now,
            accumulatedWaitMs: 0,
          },
        })
      : null;

    const session = await tx.playSession.update({
      where: { id: sessionId },
      data: { version: { increment: 1 } },
      select: { version: true },
    });

    await writeAudit(tx, {
      clubId: access.session.clubId,
      sessionId,
      actorId,
      action: 'guest.created',
      entityType: 'SessionGuest',
      entityId: guest.id,
      summary: `Guest ${guest.displayName} added${queueEntry ? ' and queued' : ''}`,
      metadata: {
        guestId: guest.id,
        displayName: guest.displayName,
        gender: guest.gender,
        skillRating: guest.skillRating,
        addToQueue: Boolean(queueEntry),
        queueEntryId: queueEntry?.id ?? null,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { guest, queueEntry, version: session.version };
  });

  publishSessionEvent({
    sessionId,
    publicId: access.session.publicId,
    type: 'queue.updated',
    version: result.version,
    payload: { guestId: result.guest.id, queued: Boolean(result.queueEntry) },
    publicPayload: { participantsChanged: true },
  });

  return {
    guest: guestDto(result.guest, result.queueEntry?.state ?? null),
    version: result.version,
  };
}

export async function updateGuest(
  sessionId: string,
  actorId: string,
  guestId: string,
  input: {
    displayName?: string;
    gender?: string;
    skillRating?: number;
    expectedVersion?: number;
  },
  meta: AuditMeta,
) {
  const access = await getSessionForPermission(sessionId, actorId, 'sessions.guests.manage');
  assertSessionNotEnded(access.session);
  const guest = await findGuest(sessionId, guestId);
  if (guest.status !== 'ACTIVE') throw AppError.conflict('This guest has been removed');
  if (input.expectedVersion !== undefined && input.expectedVersion !== guest.version) {
    throw AppError.conflict('This guest was changed by someone else. Refresh and try again.');
  }

  const queue = await findQueueEntry(sessionId, guest.id);
  if (
    input.skillRating !== undefined &&
    input.skillRating !== guest.skillRating &&
    queue &&
    ACTIVE_MATCH_STATES.includes(queue.state)
  ) {
    throw AppError.conflict(
      'The skill level cannot change while the guest is in an active match. Try again after the match.',
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const lockedQueue = await tx.queueEntry.findUnique({
      where: { sessionId_participantId: { sessionId, participantId: guest.id } },
    });
    if (
      input.skillRating !== undefined &&
      input.skillRating !== guest.skillRating &&
      lockedQueue &&
      ACTIVE_MATCH_STATES.includes(lockedQueue.state)
    ) {
      throw AppError.conflict(
        'The skill level cannot change while the guest is in an active match. Try again after the match.',
      );
    }
    const updated = await tx.sessionGuest.updateMany({
      where: { id: guest.id, sessionId, version: guest.version },
      data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.gender !== undefined ? { gender: input.gender } : {}),
        ...(input.skillRating !== undefined ? { skillRating: input.skillRating } : {}),
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) {
      throw AppError.conflict('This guest was changed by someone else. Refresh and try again.');
    }
    const session = await tx.playSession.update({
      where: { id: sessionId },
      data: { version: { increment: 1 } },
      select: { version: true },
    });
    const next = await tx.sessionGuest.findUniqueOrThrow({ where: { id: guest.id } });
    await writeAudit(tx, {
      clubId: access.session.clubId,
      sessionId,
      actorId,
      action: 'guest.updated',
      entityType: 'SessionGuest',
      entityId: guest.id,
      summary: `Guest ${next.displayName} updated`,
      metadata: {
        guestId: guest.id,
        changed: {
          displayName: input.displayName !== undefined,
          gender: input.gender !== undefined,
          skillRating: input.skillRating !== undefined,
        },
        before: {
          displayName: guest.displayName,
          gender: guest.gender,
          skillRating: guest.skillRating,
        },
        after: {
          displayName: next.displayName,
          gender: next.gender,
          skillRating: next.skillRating,
        },
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { guest: next, version: session.version };
  });

  publishSessionEvent({
    sessionId,
    publicId: access.session.publicId,
    type: 'queue.updated',
    version: result.version,
    payload: { guestId: guest.id, updated: true },
  });

  return {
    guest: guestDto(result.guest, queue?.state ?? null),
    version: result.version,
  };
}

export async function removeGuest(
  sessionId: string,
  actorId: string,
  guestId: string,
  meta: AuditMeta,
) {
  const access = await getSessionForPermission(sessionId, actorId, 'sessions.guests.manage');
  assertSessionNotEnded(access.session);
  const guest = await findGuest(sessionId, guestId);
  if (guest.status === 'REMOVED') {
    return { removed: true, alreadyRemoved: true, version: access.session.version };
  }

  const queue = await findQueueEntry(sessionId, guest.id);
  if (queue && ACTIVE_MATCH_STATES.includes(queue.state)) {
    throw AppError.conflict('A guest in an active match cannot be removed');
  }

  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const lockedQueue = await tx.queueEntry.findUnique({
      where: { sessionId_participantId: { sessionId, participantId: guest.id } },
    });
    if (lockedQueue && ACTIVE_MATCH_STATES.includes(lockedQueue.state)) {
      throw AppError.conflict('A guest in an active match cannot be removed');
    }
    const updated = await tx.sessionGuest.updateMany({
      where: { id: guest.id, sessionId, status: 'ACTIVE' },
      data: {
        status: 'REMOVED',
        removedAt: now,
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) {
      throw AppError.conflict('This guest was already removed');
    }
    if (lockedQueue && lockedQueue.state !== 'LEFT') {
      await tx.queueEntry.update({
        where: { id: lockedQueue.id },
        data: {
          state: 'LEFT',
          currentMatchId: null,
          pausedAt: null,
          version: { increment: 1 },
        },
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
      action: 'guest.removed',
      entityType: 'SessionGuest',
      entityId: guest.id,
      summary: `Guest ${guest.displayName} removed from the session`,
      metadata: {
        guestId: guest.id,
        displayName: guest.displayName,
        queueEntryId: queue?.id ?? null,
        queueState: queue?.state ?? null,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { version: session.version };
  });

  publishSessionEvent({
    sessionId,
    publicId: access.session.publicId,
    type: 'queue.updated',
    version: result.version,
    payload: { guestId: guest.id, removed: true },
    publicPayload: { participantsChanged: true },
  });

  return { removed: true, alreadyRemoved: false, version: result.version };
}

export async function enqueueGuest(
  sessionId: string,
  actorId: string,
  guestId: string,
  meta: AuditMeta,
) {
  const access = await getSessionForPermission(sessionId, actorId, 'sessions.guests.manage');
  assertGuestWindow(access.session);
  const guest = await findGuest(sessionId, guestId);
  if (guest.status !== 'ACTIVE') throw AppError.conflict('This guest has been removed');

  const existing = await findQueueEntry(sessionId, guest.id);
  if (existing && existing.state !== 'LEFT') {
    if (ACTIVE_MATCH_STATES.includes(existing.state)) {
      throw AppError.conflict('This guest is already in an active match');
    }
    return {
      guest: guestDto(guest, existing.state),
      queueEntry: { id: existing.id, state: existing.state },
      version: access.session.version,
      alreadyQueued: true,
    };
  }

  const now = new Date();
  let committed: { queueEntry: { id: string; state: string }; version: number } | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 3 && !committed; attempt += 1) {
    try {
      committed = await prisma.$transaction(async (tx) => {
        const lockedQueue = existing
          ? await tx.queueEntry.findUnique({ where: { id: existing.id } })
          : null;
        if (lockedQueue && ACTIVE_MATCH_STATES.includes(lockedQueue.state)) {
          throw AppError.conflict('This guest is already in an active match');
        }
        const queueEntry = lockedQueue
          ? await tx.queueEntry.update({
              where: { id: lockedQueue.id },
              data: {
                state: 'WAITING',
                waitingSince: now,
                accumulatedWaitMs: 0,
                currentMatchId: null,
                pausedAt: null,
                restUntil: null,
                version: { increment: 1 },
              },
            })
          : await tx.queueEntry.create({
              data: {
                sessionId,
                participantId: guest.id,
                participantType: 'GUEST',
                guestId: guest.id,
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
          clubId: access.session.clubId,
          sessionId,
          actorId,
          action: 'guest.enqueued',
          entityType: 'QueueEntry',
          entityId: queueEntry.id,
          summary: `Guest ${guest.displayName} added to the queue`,
          metadata: {
            guestId: guest.id,
            queueEntryId: queueEntry.id,
            previousState: existing?.state ?? null,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return { queueEntry, version: session.version };
      });
    } catch (error) {
      // Two Queue Masters may press "add to queue" together. The unique
      // [sessionId, participantId] index lets exactly one create the entry;
      // the loser retries and returns the committed entry as idempotent.
      lastError = error;
      const concurrent = await findQueueEntry(sessionId, guest.id);
      if (concurrent && concurrent.state !== 'LEFT') {
        return {
          guest: guestDto(guest, concurrent.state),
          queueEntry: { id: concurrent.id, state: concurrent.state },
          version: access.session.version,
          alreadyQueued: true,
        };
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || error.code === 'P2034')
      ) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        continue;
      }
      throw error;
    }
  }

  if (!committed) {
    if (
      lastError instanceof Prisma.PrismaClientKnownRequestError &&
      (lastError.code === 'P2002' || lastError.code === 'P2034')
    ) {
      throw AppError.conflict('Queue enrollment is already in progress. Refresh and try again.');
    }
    throw lastError ?? AppError.conflict('Queue enrollment did not complete. Try again.');
  }

  publishSessionEvent({
    sessionId,
    publicId: access.session.publicId,
    type: 'queue.updated',
    version: committed.version,
    payload: { guestId: guest.id, queued: true },
    publicPayload: { participantsChanged: true },
  });

  return {
    guest: guestDto(guest, committed.queueEntry.state),
    queueEntry: { id: committed.queueEntry.id, state: committed.queueEntry.state },
    version: committed.version,
    alreadyQueued: false,
  };
}
