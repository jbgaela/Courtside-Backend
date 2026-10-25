import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';
import { toPublicDisplayName } from '@picklequeue/contracts';
import { toSelf } from './serializers.js';

export async function getProfile(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { profile: true },
  });
  return toSelf(user, user.profile);
}

export async function updateProfile(
  userId: string,
  input: {
    name?: string;
    displayName?: string;
    skillRating?: number;
    bio?: string | null;
    avatarColor?: string | null;
  },
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true },
  });
  if (!user) throw AppError.notFound('User not found');
  if (!user.profile) throw AppError.notFound('Player profile not found');

  const changedSkill =
    input.skillRating !== undefined && input.skillRating !== user.profile.skillRating;

  const result = await prisma.$transaction(async (tx) => {
    if (input.name !== undefined) {
      await tx.user.update({ where: { id: userId }, data: { name: input.name } });
    }
    await tx.playerProfile.update({
      where: { userId },
      data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.name !== undefined && input.displayName === undefined
          ? { displayName: input.name }
          : {}),
        ...(input.skillRating !== undefined ? { skillRating: input.skillRating } : {}),
        ...(input.bio !== undefined ? { bio: input.bio } : {}),
        ...(input.avatarColor !== undefined ? { avatarColor: input.avatarColor } : {}),
      },
    });
    if (changedSkill) {
      await tx.skillRating.create({
        data: {
          userId,
          value: input.skillRating!,
          source: 'SELF_REPORTED',
        },
      });
    }
    return tx.user.findUniqueOrThrow({ where: { id: userId }, include: { profile: true } });
  });

  return toSelf(result, result.profile);
}

export async function getStats(userId: string) {
  const [memberships, totalMatches, winsA, winsB, sessionsAttended, unread] = await Promise.all([
    prisma.clubMembership.count({ where: { userId, status: 'ACTIVE' } }),
    prisma.matchParticipant.count({
      where: { userId, match: { status: { in: ['COMPLETED', 'CORRECTED'] } } },
    }),
    prisma.matchParticipant.count({
      where: {
        userId,
        team: 'A',
        match: { status: { in: ['COMPLETED', 'CORRECTED'] }, result: { winnerTeam: 'A' } },
      },
    }),
    prisma.matchParticipant.count({
      where: {
        userId,
        team: 'B',
        match: { status: { in: ['COMPLETED', 'CORRECTED'] }, result: { winnerTeam: 'B' } },
      },
    }),
    prisma.queueEntry.count({ where: { userId } }),
    prisma.notification.count({
      where: { userId, OR: [{ readAt: null }, { readAt: { isSet: false } }] },
    }),
  ]);
  const wins = winsA + winsB;
  return {
    clubs: memberships,
    sessionsAttended,
    matchesPlayed: totalMatches,
    wins,
    losses: Math.max(0, totalMatches - wins),
    winRate: totalMatches > 0 ? Math.round((wins / totalMatches) * 1000) / 10 : 0,
    unreadNotifications: unread,
  };
}

export async function getMatchHistory(userId: string, query: { limit: number; cursor?: string }) {
  const rows = await prisma.matchParticipant.findMany({
    where: {
      userId,
      match: { status: { in: ['COMPLETED', 'CORRECTED'] } },
    },
    include: {
      match: {
        include: {
          result: true,
          participants: {
            select: { userId: true, team: true, displayName: true, skillRating: true },
          },
          session: { select: { id: true, name: true, publicId: true } },
          club: { select: { id: true, name: true, slug: true } },
          court: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  return {
    items: page.map((row) => ({
      matchId: row.match.id,
      publicId: row.match.publicId,
      round: row.match.round,
      format: row.match.format,
      status: row.match.status,
      playedAt: row.match.completedAt?.toISOString() ?? row.match.createdAt.toISOString(),
      session: row.match.session,
      club: row.match.club,
      court: row.match.court,
      team: row.team,
      partnerNames: row.match.participants
        .filter((participant) => participant.team === row.team && participant.userId !== userId)
        .map((participant) => participant.displayName),
      opponentNames: row.match.participants
        .filter((participant) => participant.team !== row.team)
        .map((participant) => participant.displayName),
      games: row.match.games,
      winnerTeam: row.match.result?.winnerTeam ?? null,
      won: row.match.result?.winnerTeam === row.team,
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function getUpcoming(userId: string) {
  const registrations = await prisma.sessionRegistration.findMany({
    where: {
      userId,
      status: { in: ['REGISTERED', 'PENDING', 'CHECKED_IN'] },
      session: {
        status: { in: ['SCHEDULED', 'CHECK_IN_OPEN', 'LIVE'] },
      },
    },
    include: {
      session: {
        include: {
          club: { select: { id: true, name: true, slug: true, archivedAt: true } },
          queueEntries: { where: { userId }, select: { state: true, gamesPlayed: true } },
          sessionCourts: {
            where: { active: true },
            include: { court: { select: { id: true, name: true, status: true } } },
          },
        },
      },
    },
    orderBy: { session: { startsAt: 'asc' } },
    take: 20,
  });

  return registrations
    .filter((registration) => !registration.session.club.archivedAt)
    .map((registration) => ({
      sessionId: registration.session.id,
      publicId: registration.session.publicId,
      name: registration.session.name,
      venue: registration.session.venue,
      startsAt: registration.session.startsAt.toISOString(),
      endsAt: registration.session.endsAt.toISOString(),
      timezone: registration.session.timezone,
      status: registration.session.status,
      club: registration.session.club,
      registrationStatus: registration.status,
      queueState: registration.session.queueEntries[0]?.state ?? null,
      gamesPlayed: registration.session.queueEntries[0]?.gamesPlayed ?? 0,
      courts: registration.session.sessionCourts.map((sessionCourt) => ({
        id: sessionCourt.court.id,
        name: sessionCourt.court.name,
        status: sessionCourt.court.status,
      })),
    }));
}

export async function listNotifications(userId: string, limit: number) {
  const notifications = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return notifications.map((notification) => ({
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    read: Boolean(notification.readAt),
    createdAt: notification.createdAt.toISOString(),
  }));
}

export async function markNotificationRead(userId: string, notificationId: string) {
  const notification = await prisma.notification.findFirst({
    where: { id: notificationId, userId },
  });
  if (!notification) throw AppError.notFound('Notification not found');
  await prisma.notification.update({
    where: { id: notification.id },
    data: { readAt: notification.readAt ?? new Date() },
  });
  return { read: true };
}

export async function markAllNotificationsRead(userId: string) {
  const result = await prisma.notification.updateMany({
    where: { userId, OR: [{ readAt: null }, { readAt: { isSet: false } }] },
    data: { readAt: new Date() },
  });
  return { updated: result.count };
}

export function publicName(displayName: string): string {
  return toPublicDisplayName(displayName);
}
