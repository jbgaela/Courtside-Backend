import 'dotenv/config';
import bcrypt from 'bcryptjs';
import {
  MATCHMAKING_DEFAULTS,
  SCORING_DEFAULTS,
  type MatchmakingConfig,
  type ScoringConfig,
} from '@picklequeue/contracts';
import { prisma } from '../src/infrastructure/prisma.js';

const DEMO_CLUB_SLUG = 'riverside-pickleball';
const PASSWORD = process.env.SEED_PASSWORD ?? 'PickleQueue123!';

interface DemoPlayer {
  key: string;
  name: string;
  email: string;
  skill: number;
}

const PLAYERS: DemoPlayer[] = [
  { key: 'owner', name: 'Morgan Lee', email: 'owner@picklequeue.dev', skill: 3.75 },
  { key: 'alex', name: 'Alex Reyes', email: 'alex@picklequeue.dev', skill: 3.5 },
  { key: 'jordan', name: 'Jordan Kim', email: 'jordan@picklequeue.dev', skill: 4.0 },
  { key: 'sam', name: 'Sam Patel', email: 'sam@picklequeue.dev', skill: 3.25 },
  { key: 'priya', name: 'Priya Nair', email: 'priya@picklequeue.dev', skill: 4.25 },
  { key: 'diego', name: 'Diego Santos', email: 'diego@picklequeue.dev', skill: 4.0 },
  { key: 'maria', name: 'Maria Lopez', email: 'maria@picklequeue.dev', skill: 3.0 },
  { key: 'sofia', name: 'Sofia Reyes', email: 'sofia@picklequeue.dev', skill: 3.75 },
  { key: 'ken', name: 'Ken Tan', email: 'ken@picklequeue.dev', skill: 3.25 },
  { key: 'liam', name: 'Liam Cruz', email: 'liam@picklequeue.dev', skill: 3.0 },
  { key: 'ava', name: 'Ava Brooks', email: 'ava@picklequeue.dev', skill: 4.5 },
  { key: 'noah', name: 'Noah Williams', email: 'noah@picklequeue.dev', skill: 2.75 },
  { key: 'zoe', name: 'Zoe Chen', email: 'zoe@picklequeue.dev', skill: 3.5 },
  { key: 'ethan', name: 'Ethan Park', email: 'ethan@picklequeue.dev', skill: 4.25 },
  { key: 'lena', name: 'Lena Ortiz', email: 'lena@picklequeue.dev', skill: 3.25 },
];

async function cleanupDemoClub(): Promise<void> {
  const club = await prisma.club.findUnique({ where: { slug: DEMO_CLUB_SLUG } });
  if (!club) return;
  const sessions = await prisma.playSession.findMany({
    where: { clubId: club.id },
    select: { id: true },
  });
  const sessionIds = sessions.map((session) => session.id);
  const matches = await prisma.match.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { id: true },
  });
  const matchIds = matches.map((match) => match.id);
  await prisma.$transaction([
    prisma.matchResult.deleteMany({ where: { matchId: { in: matchIds } } }),
    prisma.scoreEvent.deleteMany({ where: { matchId: { in: matchIds } } }),
    prisma.matchParticipant.deleteMany({ where: { matchId: { in: matchIds } } }),
    prisma.courtAssignment.deleteMany({ where: { sessionId: { in: sessionIds } } }),
    prisma.rotationRun.deleteMany({ where: { sessionId: { in: sessionIds } } }),
    prisma.match.deleteMany({ where: { sessionId: { in: sessionIds } } }),
    prisma.queueEntry.deleteMany({ where: { sessionId: { in: sessionIds } } }),
    prisma.sessionRegistration.deleteMany({ where: { sessionId: { in: sessionIds } } }),
    prisma.sessionCourt.deleteMany({ where: { sessionId: { in: sessionIds } } }),
    prisma.auditEvent.deleteMany({ where: { clubId: club.id } }),
    prisma.playSession.deleteMany({ where: { clubId: club.id } }),
    prisma.court.deleteMany({ where: { clubId: club.id } }),
    prisma.clubInvitation.deleteMany({ where: { clubId: club.id } }),
    prisma.clubMembership.deleteMany({ where: { clubId: club.id } }),
    prisma.club.delete({ where: { id: club.id } }),
  ]);
}

async function upsertDemoUsers(): Promise<Map<string, { id: string }>> {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const map = new Map<string, { id: string }>();
  for (const player of PLAYERS) {
    const user = await prisma.user.upsert({
      where: { email: player.email },
      update: {
        name: player.name,
        passwordHash: hash,
        emailVerifiedAt: new Date(),
      },
      create: {
        email: player.email,
        name: player.name,
        passwordHash: hash,
        emailVerifiedAt: new Date(),
        profile: {
          create: {
            displayName: player.name,
            skillRating: player.skill,
          },
        },
      },
    });
    await prisma.playerProfile.upsert({
      where: { userId: user.id },
      update: { displayName: player.name, skillRating: player.skill },
      create: { userId: user.id, displayName: player.name, skillRating: player.skill },
    });
    map.set(player.key, { id: user.id });
  }
  return map;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!process.env.NODE_ENV) throw new Error('NODE_ENV is required');
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error(
      'Refusing to seed demo accounts in production. Set ALLOW_DEMO_SEED=true only for a disposable demo environment.',
    );
  }
  if (process.env.NODE_ENV === 'production' && !process.env.SEED_PASSWORD) {
    throw new Error('SEED_PASSWORD must be set explicitly for a production demo seed');
  }
  console.log('Resetting demo club (only riverside-pickleball is touched)...');
  await cleanupDemoClub();
  const users = await upsertDemoUsers();
  const id = (key: string): string => {
    const user = users.get(key);
    if (!user) throw new Error(`Missing demo user ${key}`);
    return user.id;
  };

  const ownerId = id('owner');
  const club = await prisma.club.create({
    data: {
      slug: DEMO_CLUB_SLUG,
      name: 'Riverside Pickleball Club',
      description:
        'Friendly open play on three riverside courts. Skill-balanced rotations, every Saturday.',
      location: 'Riverside Courts, Austin',
      joinPolicy: 'OPEN',
      ownerId,
      memberships: {
        create: PLAYERS.map((player) => ({
          userId: id(player.key),
          role:
            player.key === 'owner' ? 'OWNER' : player.key === 'jordan' ? 'QUEUE_MASTER' : 'PLAYER',
          status: 'ACTIVE',
          joinedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        })),
      },
      courts: {
        create: [
          { name: 'Court 1', status: 'AVAILABLE', sortOrder: 0 },
          { name: 'Court 2', status: 'AVAILABLE', sortOrder: 1 },
          { name: 'Court 3', status: 'AVAILABLE', sortOrder: 2 },
        ],
      },
    },
    include: { courts: true },
  });

  const courts = new Map(club.courts.map((court) => [court.name, court]));
  const now = new Date();
  const startsAt = new Date(now.getTime() - 75 * 60_000);
  const endsAt = new Date(now.getTime() + 165 * 60_000);

  const matchmaking: MatchmakingConfig = {
    ...MATCHMAKING_DEFAULTS,
    strategy: 'HYBRID',
    format: 'DOUBLES',
    preferredSkillSpread: 0.75,
    maxSkillSpread: 1.5,
    minRestMinutes: 5,
    autoAssign: false,
    maxGamesPerPlayer: 6,
  };
  const scoring: ScoringConfig = { ...SCORING_DEFAULTS, targetScore: 11, winByTwo: true };

  const liveSession = await prisma.playSession.create({
    data: {
      clubId: club.id,
      publicId: 's_riverside_saturday',
      checkInToken: 'demo-checkin-riverside-saturday-2026',
      name: 'Saturday Open Play',
      description: 'Three courts, rotating partners, all levels welcome.',
      venue: 'Riverside Courts',
      startsAt,
      endsAt,
      timezone: 'America/Chicago',
      status: 'LIVE',
      capacity: 24,
      format: 'DOUBLES',
      registrationPolicy: 'OPEN',
      checkInPolicy: 'SELF',
      published: true,
      allowLateArrivals: true,
      matchmakingConfig: matchmaking as unknown as object,
      scoringConfig: scoring as unknown as object,
      version: 14,
      createdById: ownerId,
      checkInOpensAt: new Date(startsAt.getTime() - 30 * 60_000),
      startedAt: new Date(startsAt.getTime() + 20 * 60_000),
      sessionCourts: {
        create: [0, 1, 2].map((index) => ({
          courtId: club.courts[index]!.id,
          active: true,
          sortOrder: index,
        })),
      },
      registrations: {
        create: [
          'alex',
          'sam',
          'priya',
          'diego',
          'maria',
          'sofia',
          'ken',
          'liam',
          'ava',
          'noah',
          'zoe',
          'ethan',
          'lena',
        ].map((key) => ({
          userId: id(key),
          status: 'CHECKED_IN',
          checkedInAt: new Date(startsAt.getTime() + 5 * 60_000),
          checkInMethod: 'SELF',
        })),
      },
    },
  });

  const upcoming = await prisma.playSession.create({
    data: {
      clubId: club.id,
      publicId: 's_riverside_sunday',
      checkInToken: 'demo-checkin-riverside-sunday-2026',
      name: 'Sunday Social',
      description: 'Relaxed Sunday doubles with a mixed-skill rotation.',
      venue: 'Riverside Courts',
      startsAt: new Date(now.getTime() + 20 * 60 * 60_000),
      endsAt: new Date(now.getTime() + 23 * 60 * 60_000),
      timezone: 'America/Chicago',
      status: 'SCHEDULED',
      capacity: 20,
      format: 'DOUBLES',
      registrationPolicy: 'OPEN',
      checkInPolicy: 'SELF',
      published: true,
      allowLateArrivals: true,
      matchmakingConfig: matchmaking as unknown as object,
      scoringConfig: scoring as unknown as object,
      version: 1,
      createdById: ownerId,
      sessionCourts: {
        create: [0, 1].map((index) => ({
          courtId: club.courts[index]!.id,
          active: true,
          sortOrder: index,
        })),
      },
      registrations: {
        create: ['alex', 'sam', 'priya', 'diego'].map((key) => ({
          userId: id(key),
          status: 'REGISTERED',
        })),
      },
    },
  });

  const queueSpec: Array<{
    key: string;
    state: 'PLAYING' | 'WAITING';
    games: number;
    waitMinutes: number;
    match?: string;
  }> = [
    { key: 'sam', state: 'PLAYING', games: 1, waitMinutes: 0, match: 'live-1' },
    { key: 'priya', state: 'PLAYING', games: 1, waitMinutes: 0, match: 'live-1' },
    { key: 'diego', state: 'PLAYING', games: 1, waitMinutes: 0, match: 'live-1' },
    { key: 'maria', state: 'PLAYING', games: 1, waitMinutes: 0, match: 'live-1' },
    { key: 'sofia', state: 'PLAYING', games: 2, waitMinutes: 0, match: 'live-2' },
    { key: 'ken', state: 'PLAYING', games: 2, waitMinutes: 0, match: 'live-2' },
    { key: 'liam', state: 'PLAYING', games: 3, waitMinutes: 0, match: 'live-2' },
    { key: 'ava', state: 'PLAYING', games: 1, waitMinutes: 0, match: 'live-2' },
    { key: 'alex', state: 'WAITING', games: 2, waitMinutes: 8 },
    { key: 'noah', state: 'WAITING', games: 1, waitMinutes: 14 },
    { key: 'zoe', state: 'WAITING', games: 3, waitMinutes: 5 },
    { key: 'ethan', state: 'WAITING', games: 1, waitMinutes: 12 },
    { key: 'lena', state: 'WAITING', games: 2, waitMinutes: 9 },
  ];

  const playerInfo = (key: string) => {
    const player = PLAYERS.find((entry) => entry.key === key);
    if (!player) throw new Error(`Unknown player ${key}`);
    return player;
  };

  const live1 = await prisma.match.create({
    data: {
      sessionId: liveSession.id,
      clubId: club.id,
      courtId: courts.get('Court 1')!.id,
      publicId: 'm_riverside_live_1',
      round: 7,
      format: 'DOUBLES',
      status: 'IN_PROGRESS',
      scoringMode: 'RALLY',
      targetScore: 11,
      winByTwo: true,
      bestOf: 1,
      games: [{ a: 9, b: 7 }] as unknown as object,
      gamesWonA: 0,
      gamesWonB: 0,
      servingTeam: 'A',
      teamAScore: 9,
      teamBScore: 7,
      configSnapshot: scoring as unknown as object,
      startedAt: new Date(now.getTime() - 18 * 60_000),
      scorekeeperId: id('jordan'),
      participants: {
        create: [
          {
            userId: id('sam'),
            team: 'A',
            position: 0,
            displayName: 'Sam Patel',
            skillRating: 3.25,
          },
          {
            userId: id('priya'),
            team: 'A',
            position: 1,
            displayName: 'Priya Nair',
            skillRating: 4.25,
          },
          {
            userId: id('diego'),
            team: 'B',
            position: 0,
            displayName: 'Diego Santos',
            skillRating: 4.0,
          },
          {
            userId: id('maria'),
            team: 'B',
            position: 1,
            displayName: 'Maria Lopez',
            skillRating: 3.0,
          },
        ],
      },
    },
  });

  const live2 = await prisma.match.create({
    data: {
      sessionId: liveSession.id,
      clubId: club.id,
      courtId: courts.get('Court 2')!.id,
      publicId: 'm_riverside_live_2',
      round: 7,
      format: 'DOUBLES',
      status: 'IN_PROGRESS',
      scoringMode: 'RALLY',
      targetScore: 11,
      winByTwo: true,
      bestOf: 1,
      games: [{ a: 4, b: 3 }] as unknown as object,
      gamesWonA: 0,
      gamesWonB: 0,
      servingTeam: 'B',
      teamAScore: 4,
      teamBScore: 3,
      configSnapshot: scoring as unknown as object,
      startedAt: new Date(now.getTime() - 9 * 60_000),
      scorekeeperId: id('jordan'),
      participants: {
        create: [
          {
            userId: id('sofia'),
            team: 'A',
            position: 0,
            displayName: 'Sofia Reyes',
            skillRating: 3.75,
          },
          { userId: id('ken'), team: 'A', position: 1, displayName: 'Ken Tan', skillRating: 3.25 },
          {
            userId: id('liam'),
            team: 'B',
            position: 0,
            displayName: 'Liam Cruz',
            skillRating: 3.0,
          },
          {
            userId: id('ava'),
            team: 'B',
            position: 1,
            displayName: 'Ava Brooks',
            skillRating: 4.5,
          },
        ],
      },
    },
  });

  await prisma.court.updateMany({
    where: { id: { in: [courts.get('Court 1')!.id, courts.get('Court 2')!.id] } },
    data: { status: 'IN_USE' },
  });

  for (const entry of queueSpec) {
    const matchId =
      entry.match === 'live-1' ? live1.id : entry.match === 'live-2' ? live2.id : null;
    await prisma.queueEntry.create({
      data: {
        sessionId: liveSession.id,
        userId: id(entry.key),
        state: entry.state,
        gamesPlayed: entry.games,
        wins: Math.floor(entry.games / 2),
        losses: entry.games - Math.floor(entry.games / 2),
        waitingSince: new Date(now.getTime() - entry.waitMinutes * 60_000),
        currentMatchId: matchId,
        joinedAt: new Date(startsAt.getTime() + 8 * 60_000),
      },
    });
  }

  // Earlier completed results give the public page and player history real content.
  const completedSpecs = [
    {
      publicId: 'm_riverside_result_1',
      round: 6,
      court: 'Court 3',
      teamA: ['alex', 'ava'],
      teamB: ['noah', 'zoe'],
      scoreA: 11,
      scoreB: 8,
      winner: 'A',
      minutesAgo: 42,
    },
    {
      publicId: 'm_riverside_result_2',
      round: 6,
      court: 'Court 1',
      teamA: ['ethan', 'lena'],
      teamB: ['sam', 'priya'],
      scoreA: 7,
      scoreB: 11,
      winner: 'B',
      minutesAgo: 50,
    },
    {
      publicId: 'm_riverside_result_3',
      round: 5,
      court: 'Court 2',
      teamA: ['jordan', 'maria'],
      teamB: ['sofia', 'noah'],
      scoreA: 11,
      scoreB: 9,
      winner: 'A',
      minutesAgo: 70,
    },
  ] as const;

  for (const spec of completedSpecs) {
    const completedAt = new Date(now.getTime() - spec.minutesAgo * 60_000);
    const match = await prisma.match.create({
      data: {
        sessionId: liveSession.id,
        clubId: club.id,
        courtId: courts.get(spec.court)!.id,
        publicId: spec.publicId,
        round: spec.round,
        format: 'DOUBLES',
        status: 'COMPLETED',
        scoringMode: 'RALLY',
        targetScore: 11,
        winByTwo: true,
        bestOf: 1,
        games: [{ a: spec.scoreA, b: spec.scoreB }] as unknown as object,
        gamesWonA: spec.winner === 'A' ? 1 : 0,
        gamesWonB: spec.winner === 'B' ? 1 : 0,
        winnerTeam: spec.winner,
        teamAScore: spec.scoreA,
        teamBScore: spec.scoreB,
        awaitingCompletion: false,
        configSnapshot: scoring as unknown as object,
        startedAt: new Date(completedAt.getTime() - 18 * 60_000),
        completedAt,
        scorekeeperId: id('jordan'),
        participants: {
          create: [
            ...spec.teamA.map((key, index) => ({
              userId: id(key),
              team: 'A',
              position: index,
              displayName: playerInfo(key).name,
              skillRating: playerInfo(key).skill,
            })),
            ...spec.teamB.map((key, index) => ({
              userId: id(key),
              team: 'B',
              position: index,
              displayName: playerInfo(key).name,
              skillRating: playerInfo(key).skill,
            })),
          ],
        },
      },
    });
    await prisma.matchResult.create({
      data: {
        matchId: match.id,
        sessionId: liveSession.id,
        winnerTeam: spec.winner,
        gamesWonA: spec.winner === 'A' ? 1 : 0,
        gamesWonB: spec.winner === 'B' ? 1 : 0,
        games: [{ a: spec.scoreA, b: spec.scoreB }] as unknown as object,
        completedAt,
        recordedById: id('jordan'),
      },
    });
  }

  await prisma.auditEvent.create({
    data: {
      clubId: club.id,
      sessionId: liveSession.id,
      actorId: ownerId,
      action: 'session.status_live',
      entityType: 'PlaySession',
      entityId: liveSession.id,
      summary: 'Demo session moved to live',
      metadata: { seeded: true },
    },
  });

  await prisma.notification.createMany({
    data: [
      {
        userId: id('alex'),
        clubId: club.id,
        sessionId: liveSession.id,
        type: 'MATCH_COMPLETED',
        title: 'Match complete',
        body: 'You and Ava won 11–8 on Court 3. Your next rotation is coming up.',
      },
      {
        userId: id('alex'),
        clubId: club.id,
        sessionId: liveSession.id,
        type: 'QUEUE_UPDATE',
        title: 'You are #1 in the queue',
        body: 'Court 3 opens next. Stay close to the court.',
      },
    ],
  });

  console.log('');
  console.log('PickleQueue demo data ready.');
  console.log('  Club:       Riverside Pickleball Club');
  console.log(`  Live:       /public/sessions/${liveSession.publicId}`);
  console.log(`  Upcoming:   ${upcoming.name}`);
  console.log('  Password for all demo accounts: ' + PASSWORD);
  console.log('  Queue Master: owner@picklequeue.dev  (Morgan Lee)');
  console.log('  Player:       alex@picklequeue.dev   (Alex Reyes)');
  console.log('  Queue Master: jordan@picklequeue.dev (Jordan Kim)');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
