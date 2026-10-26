import type { Court, Match, MatchParticipant, PlaySession, Club } from '@prisma/client';
import { toPublicDisplayName, type ScoringConfig } from '@picklequeue/contracts';
import type { GameScore } from '@picklequeue/scoring';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';

type PublicMatchInput = Match & { participants: MatchParticipant[]; court: Court };

export function toPublicMatch(match: PublicMatchInput) {
  const games = (match.games as unknown as GameScore[]) ?? [];
  const current = games[games.length - 1] ?? { a: 0, b: 0 };
  const mapPlayer = (participant: MatchParticipant) => ({
    name: toPublicDisplayName(participant.displayName),
    skillRating: participant.skillRating,
  });
  return {
    id: match.publicId,
    court: { name: match.court.name },
    round: match.round,
    format: match.format,
    status: match.status,
    scoring: match.configSnapshot as unknown as ScoringConfig,
    games: games.map((game) => ({ a: game.a, b: game.b })),
    currentGame: current,
    gamesWonA: match.gamesWonA,
    gamesWonB: match.gamesWonB,
    winnerTeam: match.winnerTeam,
    startedAt: match.startedAt?.toISOString() ?? null,
    completedAt: match.completedAt?.toISOString() ?? null,
    teams: {
      A: match.participants.filter((p) => p.team === 'A').map(mapPlayer),
      B: match.participants.filter((p) => p.team === 'B').map(mapPlayer),
    },
  };
}

async function getPublishedSession(publicId: string) {
  const session = await prisma.playSession.findUnique({
    where: { publicId },
    include: { club: true },
  });
  if (
    !session ||
    !session.published ||
    session.status === 'DRAFT' ||
    session.status === 'CANCELLED'
  ) {
    throw AppError.notFound('Public session not found');
  }
  if (session.club.archivedAt) throw AppError.notFound('Public session not found');
  return session;
}

async function sessionPublicData(session: PlaySession & { club: Club }) {
  const [courts, matches, results, checkedIn, guests, waiting] = await Promise.all([
    prisma.sessionCourt.findMany({
      where: { sessionId: session.id, active: true },
      include: { court: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.match.findMany({
      where: {
        sessionId: session.id,
        status: { in: ['READY', 'RESERVED', 'IN_PROGRESS'] },
      },
      include: { participants: true, court: true },
      orderBy: { round: 'asc' },
    }),
    prisma.match.findMany({
      where: { sessionId: session.id, status: { in: ['COMPLETED', 'CORRECTED'] } },
      include: { participants: true, court: true },
      orderBy: { completedAt: 'desc' },
      take: 20,
    }),
    prisma.sessionRegistration.count({ where: { sessionId: session.id, status: 'CHECKED_IN' } }),
    prisma.sessionGuest.count({ where: { sessionId: session.id, status: 'ACTIVE' } }),
    prisma.queueEntry.count({ where: { sessionId: session.id, state: 'WAITING' } }),
  ]);

  const matchByCourt = new Map(matches.map((match) => [match.courtId, match]));
  return {
    id: session.publicId,
    name: session.name,
    description: session.description,
    venue: session.venue,
    timezone: session.timezone,
    startsAt: session.startsAt.toISOString(),
    endsAt: session.endsAt.toISOString(),
    status: session.status,
    format: session.format,
    published: session.published,
    version: session.version,
    club: {
      id: session.club.slug,
      name: session.club.name,
      location: session.club.location,
    },
    counts: {
      checkedIn: checkedIn + guests,
      waiting,
      courts: courts.length,
    },
    courts: courts.map((row) => {
      const active = matchByCourt.get(row.courtId);
      return {
        id: row.court.id,
        name: row.court.name,
        status: active ? 'IN_USE' : row.court.status,
        match: active ? toPublicMatch(active) : null,
      };
    }),
    matches: matches.map(toPublicMatch),
    results: results.map(toPublicMatch),
  };
}

export async function getPublicSession(publicId: string) {
  const session = await getPublishedSession(publicId);
  return sessionPublicData(session);
}

/**
 * Public preview for a QR check-in link. Shows only what a person holding the
 * link needs before signing in: which session it belongs to, when it is, and
 * whether joining is currently possible. It never exposes player identities.
 */
export async function getPublicCheckIn(token: string) {
  const session = await prisma.playSession.findUnique({
    where: { checkInToken: token },
    include: { club: true },
  });
  if (!session || session.club.archivedAt) {
    throw AppError.notFound('This check-in link is not valid');
  }
  const [checkedIn, guests, registered, waiting] = await Promise.all([
    prisma.sessionRegistration.count({ where: { sessionId: session.id, status: 'CHECKED_IN' } }),
    prisma.sessionGuest.count({ where: { sessionId: session.id, status: 'ACTIVE' } }),
    prisma.sessionRegistration.count({ where: { sessionId: session.id, status: 'REGISTERED' } }),
    prisma.queueEntry.count({ where: { sessionId: session.id, state: 'WAITING' } }),
  ]);
  const checkedInTotal = checkedIn + guests;
  const isOpen = ['CHECK_IN_OPEN', 'LIVE'].includes(session.status);
  const lateAllowed = session.status !== 'LIVE' || session.allowLateArrivals;
  const full = checkedInTotal >= session.capacity;
  const availability = !isOpen || !lateAllowed ? 'CLOSED' : full ? 'FULL' : 'OPEN';
  const closedReason =
    session.status === 'COMPLETED'
      ? 'This session has ended.'
      : session.status === 'CANCELLED'
        ? 'This session was cancelled.'
        : session.status === 'DRAFT' || session.status === 'SCHEDULED'
          ? 'Check-in has not opened yet.'
          : session.status === 'LIVE' && !session.allowLateArrivals
            ? 'Late check-in is closed for this session.'
            : 'Check-in is not open for this session.';
  const guestJoinEnabled = (session.guestJoinPolicy ?? 'DISABLED') === 'OPEN';
  const selfCheckInAllowed = session.checkInPolicy !== 'MANAGER';
  const canGuestJoin = availability === 'OPEN' && guestJoinEnabled && selfCheckInAllowed;
  const guestJoinReason = !guestJoinEnabled
    ? 'Guest joining is not enabled for this session.'
    : !selfCheckInAllowed
      ? 'This session requires a Queue Master to check players in.'
      : availability === 'FULL'
        ? 'This session is full.'
        : availability === 'CLOSED'
          ? closedReason
          : null;
  return {
    club: {
      name: session.club.name,
      location: session.club.location,
    },
    session: {
      name: session.name,
      status: session.status,
      format: session.format,
      venue: session.venue,
      timezone: session.timezone,
      startsAt: session.startsAt.toISOString(),
      endsAt: session.endsAt.toISOString(),
      capacity: session.capacity,
      checkedIn: checkedInTotal,
      registered,
      waiting,
    },
    join: {
      availability,
      canCheckIn: availability === 'OPEN',
      canGuestJoin,
      guestJoinEnabled,
      guestJoinReason,
      registrationPolicy: session.registrationPolicy,
      checkInPolicy: session.checkInPolicy,
      reason:
        availability === 'CLOSED'
          ? closedReason
          : availability === 'FULL'
            ? 'This session has reached capacity.'
            : null,
    },
  };
}

export async function getPublicLiveMatches(publicId: string) {
  const session = await getPublishedSession(publicId);
  const matches = await prisma.match.findMany({
    where: {
      sessionId: session.id,
      status: { in: ['READY', 'RESERVED', 'IN_PROGRESS'] },
    },
    include: { participants: true, court: true },
    orderBy: { round: 'asc' },
  });
  return {
    sessionId: session.publicId,
    version: session.version,
    matches: matches.map(toPublicMatch),
  };
}

export async function getPublicResults(publicId: string) {
  const session = await getPublishedSession(publicId);
  const results = await prisma.match.findMany({
    where: { sessionId: session.id, status: { in: ['COMPLETED', 'CORRECTED'] } },
    include: { participants: true, court: true },
    orderBy: { completedAt: 'desc' },
    take: 50,
  });
  return {
    sessionId: session.publicId,
    version: session.version,
    results: results.map(toPublicMatch),
  };
}

export async function getPublicClub(slug: string) {
  const club = await prisma.club.findUnique({ where: { slug } });
  if (!club || club.archivedAt) throw AppError.notFound('Club not found');
  const sessions = await prisma.playSession.findMany({
    where: {
      clubId: club.id,
      published: true,
      status: { in: ['SCHEDULED', 'CHECK_IN_OPEN', 'LIVE', 'COMPLETED'] },
    },
    orderBy: { startsAt: 'asc' },
    take: 20,
  });
  return {
    id: club.slug,
    name: club.name,
    description: club.description,
    location: club.location,
    sessions: sessions.map((session) => ({
      publicId: session.publicId,
      name: session.name,
      startsAt: session.startsAt.toISOString(),
      endsAt: session.endsAt.toISOString(),
      status: session.status,
      format: session.format,
    })),
  };
}
