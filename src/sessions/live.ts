import { prisma } from '../infrastructure/prisma.js';
import { getSessionAccess } from './access.js';
import { sessionDto } from './serializers.js';
import { queueSnapshot } from './participants.js';
import { getLatestRotation } from '../matchmaking/service.js';
import { matchDto } from '../matches/serializers.js';

const ACTIVE_STATUSES = ['READY', 'IN_PROGRESS', 'RESERVED'];

export async function getLiveSnapshot(sessionId: string, userId: string) {
  const access = await getSessionAccess(sessionId, userId);
  const [queue, matches, sessionCourts, rotation, registrationCounts] = await Promise.all([
    queueSnapshot(sessionId, userId),
    prisma.match.findMany({
      where: { sessionId, status: { in: ACTIVE_STATUSES } },
      include: { participants: true, court: true },
      orderBy: { court: { name: 'asc' } },
    }),
    prisma.sessionCourt.findMany({
      where: { sessionId, active: true },
      include: { court: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    getLatestRotation(sessionId, userId),
    prisma.sessionRegistration.count({ where: { sessionId, status: 'CHECKED_IN' } }),
  ]);

  const matchesByCourt = new Map(matches.map((match) => [match.courtId, match]));
  const courts = sessionCourts.map((row) => {
    const active = matchesByCourt.get(row.courtId);
    return {
      id: row.court.id,
      name: row.court.name,
      status: active ? 'IN_USE' : row.court.status,
      sortOrder: row.sortOrder,
      match: active ? matchDto(active) : null,
    };
  });

  return {
    session: sessionDto(
      access.session,
      { role: access.membership.role },
      {
        counts: {
          registered: queue.counts.registered,
          checkedIn: registrationCounts,
          waiting: queue.counts.waiting,
          playing: queue.counts.playing,
          pending: queue.counts.pending,
          courts: sessionCourts.length,
        },
        courts: sessionCourts.map((row) => ({
          id: row.court.id,
          name: row.court.name,
          status: row.court.status,
          sortOrder: row.sortOrder,
        })),
      },
    ),
    queue,
    courts,
    matches: matches.map((match) => matchDto(match)),
    rotation,
    viewerRole: access.membership.role,
    serverTime: new Date().toISOString(),
  };
}
