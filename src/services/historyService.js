import { Match } from '../models/Match.js';
import { MatchHandLog } from '../models/MatchHandLog.js';
import { AppError } from '../utils/AppError.js';
import { buildChipsSummary } from './betService.js';

const CLOSED_STATUSES = ['finished', 'cancelled'];

function resultFor(match, me) {
  if (match.status === 'cancelled') return 'cancelled';
  return me.team === match.winnerTeam ? 'won' : 'lost';
}

function toHistoryItem(match, userId) {
  const me = match.players.find((p) => String(p.userId) === userId);
  const opponent = match.players.find((p) => String(p.userId) !== userId);
  const chips = buildChipsSummary(match)?.players.find((p) => p.userId === userId) ?? null;
  return {
    id: String(match._id),
    config: { targetPoints: match.config.targetPoints, bet: match.config.bet || 0 },
    opponent: opponent ? { id: String(opponent.userId), username: opponent.username } : null,
    myTeam: me.team,
    myScore: match.score[me.team],
    opponentScore: match.score[1 - me.team],
    result: resultFor(match, me),
    endReason: match.endReason,
    abandonedByMe: match.abandonedBy ? String(match.abandonedBy) === userId : false,
    chipsNet: chips ? chips.net : 0,
    handsPlayed: match.handsPlayed,
    startedAt: match.startedAt,
    endedAt: match.endedAt
  };
}

/** Partidas terminadas o canceladas del usuario, la más reciente primero. */
export async function listMyMatches(userId, { skip, limit }) {
  const filter = { 'players.userId': userId, status: { $in: CLOSED_STATUSES } };
  const [items, total] = await Promise.all([
    Match.find(filter).sort({ endedAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    Match.countDocuments(filter)
  ]);
  return { items: items.map((m) => toHistoryItem(m, userId)), total };
}

/**
 * Detalle de una partida cerrada, mano por mano, para uno de sus jugadores.
 * Solo incluye lo que ese jugador vio en la mesa: sus cartas, las cartas jugadas y los eventos
 * públicos. Las cartas que el rival no jugó nunca se revelan (revelarían sus tantos).
 */
export async function getMatchDetail(userId, matchId) {
  const match = await Match.findById(matchId).lean();
  if (!match || !match.players.some((p) => String(p.userId) === userId)) {
    throw new AppError('La partida no existe', 404, 'NOT_FOUND');
  }
  if (!CLOSED_STATUSES.includes(match.status)) {
    throw new AppError('La partida todavía está en juego', 409, 'MATCH_IN_PROGRESS');
  }

  const logs = await MatchHandLog.find({ matchId }).sort({ handNumber: 1 }).lean();
  return {
    ...toHistoryItem(match, userId),
    players: match.players.map((p) => ({ id: String(p.userId), username: p.username, team: p.team })),
    hands: logs.map((log) => ({
      handNumber: log.handNumber,
      manoId: log.manoId,
      myCards: log.dealt?.[userId] ?? [],
      plays: log.events
        .filter((e) => e.action === 'PLAY_CARD' && e.payload?.cardId)
        .map((e) => ({ playerId: e.playerId, cardId: e.payload.cardId })),
      events: log.publicEvents ?? [],
      result: log.result,
      scoreAfter: log.scoreAfter
    }))
  };
}
