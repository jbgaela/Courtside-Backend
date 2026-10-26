import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import type { Club, Match, MatchParticipant, PlaySession, SessionGuest } from '@prisma/client';
import { toPublicDisplayName } from '@picklequeue/contracts';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';
import { env } from '../config/env.js';
import { randomToken, sha256 } from '../security/tokens.js';
import { writeAudit } from '../audit/audit.js';
import { publishSessionEvent } from '../realtime/gateway.js';

const OPEN_STATUSES = ['CHECK_IN_OPEN', 'LIVE'];
const ENDED_STATUSES = ['COMPLETED', 'CANCELLED'];
const ACTIVE_MATCH_STATES = ['PLAYING', 'RESERVED'];
const GUEST_GRACE_MS = 4 * 60 * 60 * 1000;

type GuestWithSession = SessionGuest & { session: PlaySession };

function guestCookieName(sessionId: string): string {
  return `pq_guest_${sessionId}`;
}

function cookieOptions(maxAge?: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.COOKIE_SECURE,
    path: '/',
    ...(maxAge !== undefined ? { maxAge } : {}),
  };
}

function guestExpiry(session: PlaySession, now = new Date()): Date {
  return new Date(Math.max(session.endsAt.getTime(), now.getTime()) + GUEST_GRACE_MS);
}

function readCookie(req: Request, sessionId: string): string | null {
  const value = req.cookies?.[guestCookieName(sessionId)];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function clearGuestCookie(res: Response, sessionId: string): void {
  res.clearCookie(guestCookieName(sessionId), cookieOptions());
}

async function findSessionByToken(token: string) {
  const session = await prisma.playSession.findUnique({
    where: { checkInToken: token },
    include: { club: true },
  });
  if (!session || session.club.archivedAt) {
    throw AppError.notFound('This check-in link is not valid');
  }
  return session;
}

function guestWindowReason(session: PlaySession): string | null {
  if ((session.guestJoinPolicy ?? 'DISABLED') !== 'OPEN') {
    return 'Guest joining is not enabled for this session.';
  }
  if (session.checkInPolicy === 'MANAGER') {
    return 'This session requires a Queue Master to check players in.';
  }
  if (!OPEN_STATUSES.includes(session.status)) {
    if (session.status === 'COMPLETED') return 'This session has ended.';
    if (session.status === 'CANCELLED') return 'This session was cancelled.';
    return 'Check-in has not opened yet.';
  }
  if (session.status === 'LIVE' && !session.allowLateArrivals) {
    return 'Late arrivals are disabled for this session.';
  }
  return null;
}

function assertGuestWindow(session: PlaySession): void {
  const reason = guestWindowReason(session);
  if (reason) throw AppError.conflict(reason);
}

async function findGuestByCookie(
  session: PlaySession,
  req: Request,
): Promise<GuestWithSession | null> {
  const raw = readCookie(req, session.id);
  if (!raw) return null;
  const guest = await prisma.sessionGuest.findFirst({
    where: { sessionId: session.id, guestAccessTokenHash: sha256(raw) },
    include: { session: true },
  });
  if (!guest) return null;
  if (!guest.guestAccessExpiresAt || guest.guestAccessExpiresAt <= new Date()) return null;
  return guest;
}

function publicName(participant: MatchParticipant, guestId: string): string {
  if (participant.guestId === guestId) return participant.displayName;
  return toPublicDisplayName(participant.displayName);
}

function matchView(match: Match & { court: { name: string }; participants: MatchParticipant[] }, guest: SessionGuest) {
  const own = match.participants.find((participant) => participant.guestId === guest.id);
  const team = own?.team === 'B' ? 'B' : 'A';
  const yourTeam = match.participants
    .filter((participant) => participant.team === team)
    .map((participant) => publicName(participant, guest.id));
  const opponents = match.participants
    .filter((participant) => participant.team !== team)
    .map((participant) => publicName(participant, guest.id));
  const games = (match.games as unknown as Array<{ a: number; b: number }>) ?? [];
  const currentGame = games[games.length - 1] ?? { a: 0, b: 0 };
  const completed = match.status === 'COMPLETED' || match.status === 'CORRECTED';
  return {
    state: completed ? 'COMPLETED' : match.status === 'IN_PROGRESS' ? 'PLAYING' : 'UPCOMING',
    status: match.status,
    courtName: match.court.name,
    team,
    yourTeam,
    opponents,
    currentGame,
    games,
    gamesWonA: match.gamesWonA,
    gamesWonB: match.gamesWonB,
    winnerTeam: match.winnerTeam,
    awaitingCompletion: match.awaitingCompletion,
    completedAt: match.completedAt?.toISOString() ?? null,
  };
}

async function buildGuestStatus(session: PlaySession & { club?: Club }, guest: SessionGuest) {
  const sessionView = {
    name: session.name,
    clubName: session.club?.name ?? 'PickleQueue',
    status: session.status,
    format: session.format,
    venue: session.venue,
    timezone: session.timezone,
    startsAt: session.startsAt.toISOString(),
    endsAt: session.endsAt.toISOString(),
  };
  const guestView = {
    displayName: guest.displayName,
    status: guest.status,
    joinedAt: guest.createdAt.toISOString(),
    origin: guest.origin ?? 'MANAGER',
  };
  if (guest.status !== 'ACTIVE') {
    return {
      session: sessionView,
      guest: guestView,
      queue: null,
      match: null,
      lastResult: null,
      canLeave: false,
    };
  }
  const [queue, activeCourts] = await Promise.all([
    prisma.queueEntry.findUnique({
      where: { sessionId_participantId: { sessionId: session.id, participantId: guest.id } },
    }),
    prisma.sessionCourt.count({ where: { sessionId: session.id, active: true } }),
  ]);

  let position: number | null = null;
  let estimatedWaitMinutes: number | null = null;
  if (queue?.state === 'WAITING') {
    const waiting = await prisma.queueEntry.findMany({
      where: { sessionId: session.id, state: 'WAITING' },
      select: { id: true, gamesPlayed: true, waitingSince: true },
    });
    waiting.sort((left, right) => {
      if (left.gamesPlayed !== right.gamesPlayed) return left.gamesPlayed - right.gamesPlayed;
      return left.waitingSince.getTime() - right.waitingSince.getTime();
    });
    const index = waiting.findIndex((entry) => entry.id === queue.id);
    position = index >= 0 ? index + 1 : null;
    const slotsPerRound = Math.max(1, activeCourts * (session.format === 'SINGLES' ? 2 : 4));
    if (position !== null) {
      estimatedWaitMinutes = Math.max(0, Math.ceil((position - 1) / slotsPerRound) * 12);
    }
  }

  const latest = await prisma.matchParticipant.findFirst({
    where: {
      guestId: guest.id,
      match: {
        sessionId: session.id,
        status: { in: ['RESERVED', 'READY', 'IN_PROGRESS', 'COMPLETED', 'CORRECTED'] },
      },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      match: { include: { court: true, participants: true } },
    },
  });

  const currentMatchId = queue?.currentMatchId ?? null;
  const current = currentMatchId
    ? latest?.match.id === currentMatchId
      ? latest
      : await prisma.matchParticipant.findFirst({
          where: { guestId: guest.id, matchId: currentMatchId },
          include: { match: { include: { court: true, participants: true } } },
        })
    : null;

  const match = current ? matchView(current.match, guest) : null;
  const lastResult =
    !match && latest && ['COMPLETED', 'CORRECTED'].includes(latest.match.status)
      ? matchView(latest.match, guest)
      : null;

  const alive = guest.status === 'ACTIVE';
  return {
    session: sessionView,
    guest: guestView,
    queue: queue
      ? {
          state: queue.state,
          position,
          estimatedWaitMinutes,
          gamesPlayed: queue.gamesPlayed,
          wins: queue.wins,
          losses: queue.losses,
        }
      : null,
    match,
    lastResult,
    canLeave: Boolean(
      alive &&
        queue &&
        !ACTIVE_MATCH_STATES.includes(queue.state) &&
        !ENDED_STATUSES.includes(session.status),
    ),
  };
}

export async function joinGuestFromQr(
  token: string,
  input: { displayName: string; gender: string; skillRating: number; clientKey: string },
  req: Request,
  res: Response,
) {
  const session = await findSessionByToken(token);
  assertGuestWindow(session);

  const existingByCookie = await findGuestByCookie(session, req);
  if (existingByCookie) {
    if (existingByCookie.status === 'ACTIVE') {
      return { created: false, status: await buildGuestStatus(session, existingByCookie) };
    }
  }

  const clientKeyHash = sha256(input.clientKey);
  const existingByClient = await prisma.sessionGuest.findFirst({
    where: { sessionId: session.id, clientKeyHash },
    orderBy: { createdAt: 'desc' },
    include: { session: true },
  });
  if (existingByClient) {
    if (existingByClient.status === 'REMOVED') {
      throw AppError.conflict('You were removed from this session. Ask the Queue Master for help.');
    }
    if (existingByClient.status === 'LEFT') {
      throw AppError.conflict('You left this session. Ask the Queue Master if you want to rejoin.');
    }
    throw AppError.conflict(
      'This browser already joined this session. Reopen the QR link on the device you used to join.',
    );
  }

  const accessToken = randomToken(32);
  const accessExpiresAt = guestExpiry(session);
  const now = new Date();
  let guest: SessionGuest | null = null;
  for (let attempt = 0; attempt < 4 && !guest; attempt += 1) {
    try {
      guest = await prisma.$transaction(async (tx) => {
        const [registrations, guests] = await Promise.all([
          tx.sessionRegistration.count({
            where: {
              sessionId: session.id,
              status: { in: ['PENDING', 'REGISTERED', 'CHECKED_IN'] },
            },
          }),
          tx.sessionGuest.count({ where: { sessionId: session.id, status: 'ACTIVE' } }),
        ]);
        if (registrations + guests >= session.capacity) {
          throw AppError.conflict('This session is full');
        }
        const created = await tx.sessionGuest.create({
          data: {
            sessionId: session.id,
            clubId: session.clubId,
            displayName: input.displayName,
            gender: input.gender,
            skillRating: input.skillRating,
            origin: 'SELF',
            clientKeyHash,
            guestAccessTokenHash: sha256(accessToken),
            guestAccessExpiresAt: accessExpiresAt,
            createdById: session.createdById,
          },
        });
        await tx.queueEntry.create({
          data: {
            sessionId: session.id,
            participantId: created.id,
            participantType: 'GUEST',
            guestId: created.id,
            state: 'WAITING',
            waitingSince: now,
            accumulatedWaitMs: 0,
          },
        });
        const updated = await tx.playSession.update({
          where: { id: session.id },
          data: { version: { increment: 1 } },
          select: { version: true },
        });
        await writeAudit(tx, {
          clubId: session.clubId,
          sessionId: session.id,
          actorId: null,
          action: 'guest.self_joined',
          entityType: 'SessionGuest',
          entityId: created.id,
          summary: `Guest ${created.displayName} joined from the QR code`,
          metadata: {
            guestId: created.id,
            displayName: created.displayName,
            gender: created.gender,
            skillRating: created.skillRating,
            queued: true,
          },
          ip: req.ip,
          userAgent: req.get('user-agent'),
        });
        publishSessionEvent({
          sessionId: session.id,
          publicId: session.publicId,
          type: 'queue.updated',
          version: updated.version,
          payload: { guestId: created.id, selfJoined: true },
          publicPayload: { participantsChanged: true },
        });
        return created;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034' &&
        attempt < 3
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
        continue;
      }
      // A concurrent request for the same browser may have committed first.
      const concurrent = await prisma.sessionGuest.findFirst({
        where: { sessionId: session.id, clientKeyHash },
      });
      if (concurrent) {
        throw AppError.conflict(
          'This browser already joined this session. Refresh the QR page to see your status.',
        );
      }
      throw AppError.conflict('Another player joined at the same time. Refresh and try again.');
    }
  }
  if (!guest) {
    throw AppError.conflict('Another player joined at the same time. Refresh and try again.');
  }

  res.cookie(
    guestCookieName(session.id),
    accessToken,
    cookieOptions(accessExpiresAt.getTime() - Date.now()),
  );
  return { created: true, status: await buildGuestStatus(session, guest) };
}

export async function getGuestStatusFromQr(token: string, req: Request, res: Response) {
  const session = await findSessionByToken(token);
  const raw = readCookie(req, session.id);
  if (!raw) {
    throw AppError.unauthorized('Open the QR code again or ask the Queue Master for help.');
  }
  const guest = await prisma.sessionGuest.findFirst({
    where: { sessionId: session.id, guestAccessTokenHash: sha256(raw) },
  });
  if (!guest) {
    clearGuestCookie(res, session.id);
    throw AppError.unauthorized('This guest link is no longer valid. Ask the Queue Master for help.');
  }
  if (!guest.guestAccessExpiresAt || guest.guestAccessExpiresAt <= new Date()) {
    clearGuestCookie(res, session.id);
    throw AppError.unauthorized('This guest link has expired. Ask the Queue Master for help.');
  }
  return buildGuestStatus(session, guest);
}

export async function leaveGuestFromQr(token: string, req: Request) {
  const session = await findSessionByToken(token);
  const raw = readCookie(req, session.id);
  if (!raw) throw AppError.unauthorized('Open the QR code again to view your status.');
  const guest = await prisma.sessionGuest.findFirst({
    where: { sessionId: session.id, guestAccessTokenHash: sha256(raw) },
  });
  if (!guest) throw AppError.unauthorized('This guest link is no longer valid.');
  if (guest.status !== 'ACTIVE') {
    return { left: true, alreadyLeft: true, status: await buildGuestStatus(session, guest) };
  }
  const queue = await prisma.queueEntry.findUnique({
    where: { sessionId_participantId: { sessionId: session.id, participantId: guest.id } },
  });
  if (queue && ACTIVE_MATCH_STATES.includes(queue.state)) {
    throw AppError.conflict('You cannot leave while you are in an active match');
  }
  const updated = await prisma.$transaction(async (tx) => {
    await tx.sessionGuest.update({
      where: { id: guest.id },
      data: { status: 'LEFT', version: { increment: 1 } },
    });
    if (queue) {
      await tx.queueEntry.update({
        where: { id: queue.id },
        data: { state: 'LEFT', currentMatchId: null, version: { increment: 1 } },
      });
    }
    const sessionUpdate = await tx.playSession.update({
      where: { id: session.id },
      data: { version: { increment: 1 } },
      select: { version: true },
    });
    await writeAudit(tx, {
      clubId: session.clubId,
      sessionId: session.id,
      actorId: null,
      action: 'guest.left',
      entityType: 'SessionGuest',
      entityId: guest.id,
      summary: `Guest ${guest.displayName} left the session`,
      metadata: { guestId: guest.id, queueEntryId: queue?.id ?? null },
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    return sessionUpdate.version;
  });
  publishSessionEvent({
    sessionId: session.id,
    publicId: session.publicId,
    type: 'queue.updated',
    version: updated,
    payload: { guestId: guest.id, left: true },
    publicPayload: { participantsChanged: true },
  });
  const next = await prisma.sessionGuest.findUniqueOrThrow({ where: { id: guest.id } });
  return { left: true, alreadyLeft: false, status: await buildGuestStatus(session, next) };
}
