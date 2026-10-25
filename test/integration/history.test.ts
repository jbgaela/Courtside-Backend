import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/prisma.js';
import {
  createClub,
  createCourt,
  createSession,
  joinClub,
  previewRotation,
  registerSession,
  registerUser,
  setupLiveSession,
  transition,
  type TestUser,
} from './helpers.js';

afterAll(async () => {
  await prisma.$disconnect();
});

interface MatchBody {
  id: string;
  version: number;
  status: string;
  winnerTeam: string | null;
}

interface HistoryItem {
  matchId: string;
  winnerTeam: string | null;
  won: boolean;
  team: string;
  partnerNames: string[];
  opponentNames: string[];
  games: Array<{ a: number; b: number }>;
  status: string;
}

function playerById(players: TestUser[], userId: string): TestUser {
  const player = players.find((row) => row.id === userId);
  if (!player) throw new Error(`Player ${userId} is not part of the setup`);
  return player;
}

async function scoreWinningGame(
  actor: TestUser,
  match: MatchBody,
  team: 'A' | 'B',
): Promise<number> {
  const started = await actor.agent
    .post(`/api/v1/matches/${match.id}/start`)
    .set('x-csrf-token', actor.csrf)
    .send({})
    .expect(200);
  let version = started.body.data.match.version as number;
  for (let point = 1; point <= 11; point += 1) {
    const response = await actor.agent
      .post(`/api/v1/matches/${match.id}/score-events`)
      .set('x-csrf-token', actor.csrf)
      .set('idempotency-key', `history-point-${match.id}-${point}`)
      .send({ team, expectedVersion: version })
      .expect(201);
    version = response.body.data.match.version as number;
  }
  return version;
}

async function completeGame(
  actor: TestUser,
  match: MatchBody,
  team: 'A' | 'B',
): Promise<MatchBody> {
  const version = await scoreWinningGame(actor, match, team);
  const completed = await actor.agent
    .post(`/api/v1/matches/${match.id}/complete`)
    .set('x-csrf-token', actor.csrf)
    .set('idempotency-key', `history-complete-${match.id}`)
    .send({ expectedVersion: version })
    .expect(201);
  return completed.body.data.match as MatchBody;
}

describe('player activity history and statistics', () => {
  it('reports only finalized matches and follows an authorized correction', async () => {
    const setup = await setupLiveSession(8, 2);
    const preview = await previewRotation(setup.owner, setup.session.id);
    const committed = await setup.owner.agent
      .post(`/api/v1/sessions/${setup.session.id}/rotations/commit`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({
        rotationId: preview.rotationId,
        expectedSessionVersion: preview.sessionVersion,
      })
      .expect(201);
    const matches = committed.body.data.matches as MatchBody[];

    const firstAssignment = preview.assignments[0]!;
    const secondAssignment = preview.assignments[1]!;
    const winningPlayerId = firstAssignment.teamA[0]!.userId;
    const winningPlayer = playerById(setup.players, winningPlayerId);
    const completed = await completeGame(setup.owner, matches[0]!, 'A');
    expect(completed.winnerTeam).toBe('A');

    let stats = await winningPlayer.agent.get('/api/v1/users/me/stats').expect(200);
    expect(stats.body.data).toMatchObject({
      matchesPlayed: 1,
      wins: 1,
      losses: 0,
      winRate: 100,
    });

    let history = await winningPlayer.agent.get('/api/v1/users/me/matches').expect(200);
    expect(history.body.data.items).toHaveLength(1);
    const entry = history.body.data.items[0] as HistoryItem;
    expect(entry.matchId).toBe(completed.id);
    expect(entry.won).toBe(true);
    expect(entry.winnerTeam).toBe('A');
    expect(entry.games).toEqual([{ a: 11, b: 0 }]);
    expect(entry.partnerNames).toHaveLength(1);
    expect(entry.opponentNames).toHaveLength(2);

    // The other four players are still in a READY match. It must not count.
    const unplayedId = secondAssignment.teamA[0]!.userId;
    const unplayed = playerById(setup.players, unplayedId);
    const beforeCompletion = await unplayed.agent.get('/api/v1/users/me/stats').expect(200);
    expect(beforeCompletion.body.data.matchesPlayed).toBe(0);
    const unplayedHistory = await unplayed.agent.get('/api/v1/users/me/matches').expect(200);
    expect(unplayedHistory.body.data.items).toHaveLength(0);

    const corrected = await setup.owner.agent
      .post(`/api/v1/matches/${completed.id}/correction`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({
        games: [{ a: 0, b: 11 }],
        reason: 'Scorekeeper credited the wrong team',
        expectedVersion: completed.version,
      })
      .expect(200);
    expect(corrected.body.data.match.winnerTeam).toBe('B');

    stats = await winningPlayer.agent.get('/api/v1/users/me/stats').expect(200);
    expect(stats.body.data).toMatchObject({ matchesPlayed: 1, wins: 0, losses: 1, winRate: 0 });

    history = await winningPlayer.agent.get('/api/v1/users/me/matches').expect(200);
    const correctedEntry = history.body.data.items[0] as HistoryItem;
    expect(correctedEntry.winnerTeam).toBe('B');
    expect(correctedEntry.won).toBe(false);
    expect(correctedEntry.status).toBe('CORRECTED');

    // Cancelling the session cancels the remaining READY match. That match
    // must never be shown as a played game or a win/loss.
    await setup.owner.agent
      .post(`/api/v1/sessions/${setup.session.id}/status`)
      .set('x-csrf-token', setup.owner.csrf)
      .send({ status: 'CANCELLED', force: true, reason: 'History regression test' })
      .expect(200);

    const unplayedStats = await unplayed.agent.get('/api/v1/users/me/stats').expect(200);
    expect(unplayedStats.body.data.matchesPlayed).toBe(0);
    const afterCancellation = await unplayed.agent.get('/api/v1/users/me/matches').expect(200);
    expect(afterCancellation.body.data.items).toHaveLength(0);
    const winnerHistory = await winningPlayer.agent.get('/api/v1/users/me/matches').expect(200);
    expect(winnerHistory.body.data.items).toHaveLength(1);
  });

  it('paginates a player history without skipping or duplicating matches', async () => {
    const setup = await setupLiveSession(8, 2);
    const player = setup.players[0]!;

    for (let round = 0; round < 2; round += 1) {
      const preview = await previewRotation(setup.owner, setup.session.id);
      const committed = await setup.owner.agent
        .post(`/api/v1/sessions/${setup.session.id}/rotations/commit`)
        .set('x-csrf-token', setup.owner.csrf)
        .send({
          rotationId: preview.rotationId,
          expectedSessionVersion: preview.sessionVersion,
        })
        .expect(201);
      for (const match of committed.body.data.matches as MatchBody[]) {
        await completeGame(setup.owner, match, 'A');
      }
    }

    const all = await player.agent.get('/api/v1/users/me/matches?limit=20').expect(200);
    const allItems = all.body.data.items as HistoryItem[];
    expect(allItems.length).toBeGreaterThanOrEqual(2);
    expect(new Set(allItems.map((item) => item.matchId)).size).toBe(allItems.length);

    const firstPage = await player.agent.get('/api/v1/users/me/matches?limit=1').expect(200);
    expect(firstPage.body.data.items).toHaveLength(1);
    expect(firstPage.body.data.nextCursor).toBeTruthy();

    const secondPage = await player.agent
      .get(`/api/v1/users/me/matches?limit=1&cursor=${firstPage.body.data.nextCursor}`)
      .expect(200);
    expect(secondPage.body.data.items).toHaveLength(1);
    const ids = [
      ...(firstPage.body.data.items as HistoryItem[]).map((item) => item.matchId),
      ...(secondPage.body.data.items as HistoryItem[]).map((item) => item.matchId),
    ];
    expect(new Set(ids).size).toBe(2);
  });

  it('lists upcoming sessions and excludes completed or archived ones', async () => {
    const owner = await registerUser('upcoming-owner');
    const club = await createClub(owner, 'Upcoming club');
    const court = await createCourt(owner, club.id, 'Court 1');
    const player = await registerUser('upcoming-player');
    await joinClub(player, club.id);

    const upcoming = await createSession(owner, club.id, { courtIds: [court.id] });
    await transition(owner, upcoming.id, 'SCHEDULED');
    await registerSession(player, upcoming.id);

    let response = await player.agent.get('/api/v1/users/me/upcoming').expect(200);
    expect(
      (response.body.data as Array<{ sessionId: string }>).some(
        (row) => row.sessionId === upcoming.id,
      ),
    ).toBe(true);

    const past = await createSession(owner, club.id, { courtIds: [court.id] });
    await transition(owner, past.id, 'SCHEDULED');
    await registerSession(player, past.id);
    await transition(owner, past.id, 'CHECK_IN_OPEN');
    await transition(owner, past.id, 'CANCELLED');

    response = await player.agent.get('/api/v1/users/me/upcoming').expect(200);
    const rows = response.body.data as Array<{ sessionId: string }>;
    expect(rows.some((row) => row.sessionId === upcoming.id)).toBe(true);
    expect(rows.some((row) => row.sessionId === past.id)).toBe(false);
  });
});
