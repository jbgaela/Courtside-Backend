import type { Court, Match, MatchParticipant, MatchResult } from '@prisma/client';
import { toPublicDisplayName, type ScoringConfig } from '@picklequeue/contracts';
import type { GameScore } from '@picklequeue/scoring';

export function matchDto(
  match: Match & {
    participants: MatchParticipant[];
    court: Court;
    result?: MatchResult | null;
  },
  options: { publicView?: boolean } = {},
) {
  const games = (match.games as unknown as GameScore[]) ?? [];
  const current = games[games.length - 1] ?? { a: 0, b: 0 };
  const mapPlayer = (participant: MatchParticipant) => ({
    ...(options.publicView
      ? {}
      : {
          participantId: participant.participantId,
          participantType: participant.participantType,
          userId: participant.userId,
          guestId: participant.guestId,
        }),
    name: options.publicView
      ? toPublicDisplayName(participant.displayName)
      : participant.displayName,
    displayName: options.publicView
      ? toPublicDisplayName(participant.displayName)
      : participant.displayName,
    skillRating: participant.skillRating,
    position: participant.position,
  });
  return {
    id: match.id,
    publicId: match.publicId,
    sessionId: match.sessionId,
    clubId: match.clubId,
    court: { id: match.court.id, name: match.court.name },
    round: match.round,
    format: match.format,
    status: match.status,
    scoring: match.configSnapshot as unknown as ScoringConfig,
    games,
    currentGame: current,
    gamesWonA: match.gamesWonA,
    gamesWonB: match.gamesWonB,
    teamAScore: match.teamAScore,
    teamBScore: match.teamBScore,
    winnerTeam: match.winnerTeam,
    servingTeam: match.servingTeam,
    awaitingCompletion: match.awaitingCompletion,
    version: match.version,
    startedAt: match.startedAt?.toISOString() ?? null,
    completedAt: match.completedAt?.toISOString() ?? null,
    correctedAt: match.correctedAt?.toISOString() ?? null,
    source: match.result
      ? {
          winnerTeam: match.result.winnerTeam,
          gamesWonA: match.result.gamesWonA,
          gamesWonB: match.result.gamesWonB,
          correctedAt: match.result.correctedAt?.toISOString() ?? null,
        }
      : null,
    teams: {
      A: match.participants.filter((participant) => participant.team === 'A').map(mapPlayer),
      B: match.participants.filter((participant) => participant.team === 'B').map(mapPlayer),
    },
  };
}

export function matchSummary(
  match: Match & { court: Court },
  options: { publicView?: boolean } = {},
) {
  const games = (match.games as unknown as GameScore[]) ?? [];
  const current = games[games.length - 1] ?? { a: 0, b: 0 };
  return {
    id: match.id,
    publicId: match.publicId,
    court: options.publicView
      ? { id: match.court.id, name: match.court.name }
      : { id: match.court.id, name: match.court.name },
    round: match.round,
    status: match.status,
    games: games.map((game) => ({ a: game.a, b: game.b })),
    currentGame: current,
    gamesWonA: match.gamesWonA,
    gamesWonB: match.gamesWonB,
    winnerTeam: match.winnerTeam,
    startedAt: match.startedAt?.toISOString() ?? null,
    completedAt: match.completedAt?.toISOString() ?? null,
  };
}
