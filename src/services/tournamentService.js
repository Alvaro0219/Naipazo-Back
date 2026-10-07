import { randomInt } from 'node:crypto';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { houseFee } from '../utils/houseFee.js';
import { Room } from '../models/Room.js';
import { Tournament } from '../models/Tournament.js';
import { User } from '../models/User.js';
import * as emitter from '../sockets/emitter.js';
import { AppError } from '../utils/AppError.js';
import { bracketIndex, buildBracket, isFinalRound, nextPosition, roundName } from '../utils/bracket.js';
import { runInTransaction } from '../utils/transaction.js';
import { notifyBalances } from './betService.js';
import * as matchService from './matchService.js';
import { assertUserIsFree, createTournamentRoom } from './roomService.js';
import {
  getBalance, payTournamentEntry, payTournamentPrize, refundTournamentEntry
} from './walletService.js';

// Torneos de eliminación directa (4 u 8 jugadores). Flujo:
//   create/join (cobra la inscripción en la misma transacción) → al completarse el cupo, startTournament
//   sortea el cuadro y arranca la primera ronda → cada partida que termina avisa por matchService.onMatchFinished
//   → el ganador avanza; cuando una llave tiene a sus dos jugadores, arranca tras TOURNAMENT_NEXT_MATCH_SECONDS
//   → al terminar la final, el campeón cobra el pozo (buyIn × size, menos comisión).
// Reinicio del servidor: los torneos en juego se cancelan y se devuelven todas las inscripciones.

export const settings = {
  nextMatchDelayMs: env.tournamentNextMatchSeconds * 1000
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LOBBY_LIMIT = 50;
const timers = new Set();

function generateCode() {
  return `T${Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')}`;
}

function later(fn, ms) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    fn();
  }, ms);
  timers.add(timer);
}

function computePrize(pot, houseRate = env.houseRate) {
  return pot - houseFee(pot, houseRate);
}

export function toPublicTournament(t) {
  const usernames = new Map(t.entrants.map((e) => [String(e.userId), e.username]));
  const pot = t.config.buyIn * t.config.size;
  return {
    id: String(t._id),
    code: t.code,
    hostId: String(t.hostId),
    config: { size: t.config.size, buyIn: t.config.buyIn, targetPoints: t.config.targetPoints },
    entrants: t.entrants.map((e) => ({
      userId: String(e.userId),
      username: e.username,
      eliminated: Boolean(e.eliminated)
    })),
    status: t.status,
    cancelReason: t.cancelReason || null,
    pot,
    prize: t.status === 'finished' ? t.prize : computePrize(pot),
    bracket: (t.bracket || []).map((m) => ({
      round: m.round,
      slot: m.slot,
      roundName: roundName(t.config.size, m.round),
      players: m.players.map((p) => (p ? { userId: String(p), username: usernames.get(String(p)) || '' } : null)),
      roomId: m.roomId ? String(m.roomId) : null,
      matchId: m.matchId ? String(m.matchId) : null,
      winnerId: m.winnerId ? String(m.winnerId) : null,
      status: m.status
    })),
    winnerId: t.winnerId ? String(t.winnerId) : null,
    winnerUsername: t.winnerId ? usernames.get(String(t.winnerId)) || null : null,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    endedAt: t.endedAt
  };
}

// ─── Notificaciones ───────────────────────────────────────

export async function listLobbyTournaments() {
  const list = await Tournament.find({ status: 'waiting' }).sort({ createdAt: -1 }).limit(LOBBY_LIMIT).lean();
  return list.map(toPublicTournament);
}

async function notifyLobby() {
  try {
    emitter.toLobby('lobby:tournaments', await listLobbyTournaments());
  } catch (err) {
    console.error('No se pudo actualizar la lista de torneos:', err);
  }
}

function notifyTournament(t) {
  if (!t) return;
  const data = toPublicTournament(t);
  emitter.toTournament(data.id, 'tournament:update', data);
  // A los inscriptos también por su canal personal (aunque no estén mirando el torneo)
  for (const e of t.entrants) emitter.toUser(String(e.userId), 'tournament:update', data);
}

// ─── Inscripción ──────────────────────────────────────────

function notFound() {
  return new AppError('El torneo no existe', 404, 'NOT_FOUND');
}

async function assertCanAfford(userId, buyIn) {
  if (buyIn > 0 && (await getBalance(userId)) < buyIn) {
    throw new AppError('No tenés fichas suficientes para la inscripción', 400, 'INSUFFICIENT_BALANCE');
  }
}

/** Crea un torneo e inscribe al host (cobra su inscripción). Idempotente por `uuid`. */
export async function createTournament(user, { uuid, size, buyIn, targetPoints }) {
  const existing = await Tournament.findOne({ uuid, hostId: user.id }).lean();
  if (existing) return toPublicTournament(existing);

  await assertUserIsFree(user.id);
  await assertCanAfford(user.id, buyIn);

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const created = await runInTransaction(async (session) => {
        const entryId = new mongoose.Types.ObjectId();
        const [doc] = await Tournament.create([{
          code: generateCode(),
          hostId: user.id,
          config: { size, buyIn, targetPoints },
          entrants: [{ userId: user.id, username: user.username, entryId, paid: buyIn }],
          status: 'waiting',
          uuid
        }], { session });
        if (buyIn > 0) await chargeEntry(doc._id, user.id, entryId, buyIn, session);
        return doc;
      });
      if (buyIn > 0) await notifyBalances([user.id]);
      await notifyLobby();
      return toPublicTournament(created);
    } catch (err) {
      if (err?.code !== 11000) throw err;
      if (err.keyPattern?.uuid) {
        const again = await Tournament.findOne({ uuid, hostId: user.id }).lean();
        if (again) return toPublicTournament(again);
        throw new AppError('Identificador de torneo repetido', 409, 'CONFLICT');
      }
      // código repetido: se reintenta con otro
    }
  }
  throw new AppError('No se pudo crear el torneo, probá de nuevo', 500, 'TOURNAMENT_CODE_EXHAUSTED');
}

async function chargeEntry(tournamentId, userId, entryId, buyIn, session) {
  try {
    await payTournamentEntry(tournamentId, userId, entryId, buyIn, { session });
  } catch (err) {
    if (err?.code === 'INSUFFICIENT_BALANCE') {
      throw new AppError('No tenés fichas suficientes para la inscripción', 400, 'INSUFFICIENT_BALANCE');
    }
    throw err;
  }
}

/** Inscribe al usuario (cobra la inscripción). Si se completa el cupo, sortea el cuadro y arranca. */
export async function joinTournament(user, tournamentId) {
  const current = await Tournament.findById(tournamentId).lean();
  if (!current) throw notFound();
  if (current.entrants.some((e) => String(e.userId) === user.id)) {
    throw new AppError('Ya estás inscripto en este torneo', 409, 'ALREADY_IN_TOURNAMENT');
  }
  if (current.status !== 'waiting' || current.entrants.length >= current.config.size) {
    throw new AppError('El torneo ya no tiene cupos', 409, 'TOURNAMENT_FULL');
  }
  await assertUserIsFree(user.id);
  await assertCanAfford(user.id, current.config.buyIn);

  const entryId = new mongoose.Types.ObjectId();
  const updated = await runInTransaction(async (session) => {
    // El cupo se controla en la misma operación atómica: dos inscripciones al último lugar no pasan las dos
    const doc = await Tournament.findOneAndUpdate(
      {
        _id: tournamentId,
        status: 'waiting',
        'entrants.userId': { $ne: user.id },
        $expr: { $lt: [{ $size: '$entrants' }, '$config.size'] }
      },
      { $push: { entrants: { userId: user.id, username: user.username, entryId, paid: current.config.buyIn } } },
      { new: true, session }
    );
    if (!doc) throw new AppError('El torneo ya no tiene cupos', 409, 'TOURNAMENT_FULL');
    if (doc.config.buyIn > 0) await chargeEntry(doc._id, user.id, entryId, doc.config.buyIn, session);
    return doc;
  });

  if (updated.config.buyIn > 0) await notifyBalances([user.id]);
  if (updated.entrants.length === updated.config.size) {
    await startTournament(updated._id);
  } else {
    notifyTournament(updated);
    await notifyLobby();
  }
  return toPublicTournament(await Tournament.findById(updated._id).lean());
}

/** Sale de un torneo en inscripción y recupera su inscripción. El host no puede salir: cancela. */
export async function leaveTournament(user, tournamentId) {
  const current = await Tournament.findById(tournamentId).lean();
  if (!current) throw notFound();
  if (String(current.hostId) === user.id) {
    throw new AppError('Creaste este torneo: si no querés jugarlo, cancelalo', 400, 'HOST_CANNOT_LEAVE');
  }
  const entrant = current.entrants.find((e) => String(e.userId) === user.id);
  if (!entrant) throw new AppError('No estás inscripto en este torneo', 400, 'NOT_IN_TOURNAMENT');
  if (current.status !== 'waiting') {
    throw new AppError('El torneo ya empezó: no podés salir', 409, 'TOURNAMENT_STARTED');
  }

  const updated = await runInTransaction(async (session) => {
    const doc = await Tournament.findOneAndUpdate(
      { _id: tournamentId, status: 'waiting', 'entrants.entryId': entrant.entryId },
      { $pull: { entrants: { entryId: entrant.entryId } } },
      { new: true, session }
    );
    if (!doc) throw new AppError('El torneo ya empezó: no podés salir', 409, 'TOURNAMENT_STARTED');
    if (entrant.paid > 0) {
      await refundTournamentEntry(doc._id, user.id, entrant.entryId, entrant.paid, { session });
    }
    return doc;
  });

  if (entrant.paid > 0) await notifyBalances([user.id]);
  emitter.toUser(user.id, 'tournament:update', toPublicTournament(updated));
  notifyTournament(updated);
  await notifyLobby();
  return toPublicTournament(updated);
}

/** El host cancela un torneo en inscripción: se devuelven todas las inscripciones. */
export async function cancelTournament(user, tournamentId) {
  const cancelled = await Tournament.findOneAndUpdate(
    { _id: tournamentId, hostId: user.id, status: 'waiting' },
    { status: 'cancelled', settled: false, endedAt: new Date() },
    { new: true }
  );
  if (!cancelled) {
    const exists = await Tournament.exists({ _id: tournamentId, hostId: user.id });
    if (!exists) throw notFound();
    throw new AppError('El torneo ya empezó: no se puede cancelar', 409, 'TOURNAMENT_STARTED');
  }
  await settleTournament(cancelled._id);
  notifyTournament(cancelled);
  await notifyLobby();
  return toPublicTournament(cancelled);
}

/**
 * P6: cancela los torneos que no completaron el cupo en TOURNAMENT_WAITING_TTL_MINUTES y devuelve
 * todas las inscripciones (settleTournament es idempotente). Devuelve cuántos venció.
 */
export async function expireWaitingTournaments(now = new Date()) {
  const limit = new Date(now.getTime() - env.tournamentWaitingTtlMinutes * 60 * 1000);
  const stale = await Tournament.find({ status: 'waiting', createdAt: { $lte: limit } }).select('_id').lean();
  let expired = 0;
  for (const { _id } of stale) {
    const cancelled = await Tournament.findOneAndUpdate(
      { _id, status: 'waiting' },
      { status: 'cancelled', cancelReason: 'expired', settled: false, endedAt: now },
      { new: true }
    );
    if (!cancelled) continue;
    expired += 1;
    await settleTournament(cancelled._id);
    notifyTournament(cancelled);
  }
  if (expired) await notifyLobby();
  return expired;
}

// ─── Desarrollo del torneo ────────────────────────────────

/** Cupo completo: sortea el cuadro y arranca las partidas de la primera ronda. */
async function startTournament(tournamentId) {
  const full = await Tournament.findById(tournamentId).lean();
  const bracket = buildBracket(full.entrants.map((e) => e.userId));
  // Solo una de las llamadas concurrentes hace el sorteo
  const started = await Tournament.findOneAndUpdate(
    { _id: tournamentId, status: 'waiting', bracket: { $size: 0 } },
    { status: 'playing', bracket, startedAt: new Date() },
    { new: true }
  );
  if (!started) return;
  notifyTournament(started);
  await notifyLobby();
  for (const m of started.bracket.filter((x) => x.round === 0)) {
    await startBracketMatch(started._id, m.round, m.slot);
  }
}

/** Crea la sala y la partida de una llave con sus dos jugadores, y los lleva a la mesa. Idempotente. */
async function startBracketMatch(tournamentId, round, slot) {
  const t = await Tournament.findById(tournamentId).lean();
  if (!t || t.status !== 'playing') return;
  const index = bracketIndex(t.config.size, round, slot);
  const match = t.bracket[index];
  if (match.status !== 'ready' || match.players.some((p) => !p)) return;

  const players = match.players.map((id) => t.entrants.find((e) => String(e.userId) === String(id)));
  const created = await createTournamentRoom({ tournament: t, round, slot, players });
  if (!created) return; // ya la había creado otra llamada

  const updated = await Tournament.findOneAndUpdate(
    { _id: tournamentId, [`bracket.${index}.status`]: 'ready' },
    {
      $set: {
        [`bracket.${index}.status`]: 'playing',
        [`bracket.${index}.roomId`]: created.room._id,
        [`bracket.${index}.matchId`]: created.match._id
      }
    },
    { new: true }
  );
  if (!updated) return;
  for (const p of players) {
    emitter.toUser(String(p.userId), 'tournament:match', {
      tournamentId: String(t._id),
      round,
      roundName: roundName(t.config.size, round),
      roomId: String(created.room._id),
      matchId: String(created.match._id)
    });
  }
  notifyTournament(updated);
}

/** Terminó una partida del torneo: el ganador avanza (o es campeón) y el perdedor queda eliminado. */
export async function onMatchFinished({ tournamentId, matchId, round, winnerIds, loserIds }) {
  const t = await Tournament.findById(tournamentId).lean();
  if (!t || t.status !== 'playing') return;
  const match = t.bracket.find((m) => String(m.matchId) === String(matchId));
  if (!match || match.status === 'finished') return;
  const winnerId = winnerIds[0];
  const index = bracketIndex(t.config.size, round, match.slot);

  const set = {
    [`bracket.${index}.status`]: 'finished',
    [`bracket.${index}.winnerId`]: winnerId
  };
  const next = nextPosition(t.config.size, round, match.slot);
  let nextIndex = null;
  if (next) {
    nextIndex = bracketIndex(t.config.size, next.round, next.slot);
    set[`bracket.${nextIndex}.players.${next.position}`] = winnerId;
  }
  const updated = await Tournament.findOneAndUpdate(
    { _id: tournamentId, status: 'playing', [`bracket.${index}.status`]: 'playing' },
    { $set: set },
    { new: true }
  );
  if (!updated) return; // otra llamada ya lo registró

  await Tournament.updateOne(
    { _id: tournamentId },
    { $set: { 'entrants.$[loser].eliminated': true } },
    { arrayFilters: [{ 'loser.userId': { $in: loserIds.map((id) => new mongoose.Types.ObjectId(String(id))) } }] }
  );

  if (isFinalRound(t.config.size, round)) {
    await finishTournament(tournamentId, winnerId);
    return;
  }

  // Si la próxima llave ya tiene a sus dos jugadores, se marca lista (una sola vez) y arranca tras la pausa
  const ready = await Tournament.findOneAndUpdate(
    {
      _id: tournamentId,
      [`bracket.${nextIndex}.status`]: 'pending',
      [`bracket.${nextIndex}.players`]: { $not: { $elemMatch: { $eq: null } } }
    },
    { $set: { [`bracket.${nextIndex}.status`]: 'ready' } },
    { new: true }
  );
  notifyTournament(ready || await Tournament.findById(tournamentId).lean());
  if (ready) {
    later(() => {
      startBracketMatch(tournamentId, next.round, next.slot)
        .catch((err) => console.error(`No se pudo arrancar la llave ${next.round}/${next.slot} del torneo ${tournamentId}:`, err));
    }, settings.nextMatchDelayMs);
  }
}

async function finishTournament(tournamentId, winnerId) {
  const t = await Tournament.findById(tournamentId).lean();
  const pot = t.config.buyIn * t.config.size;
  const prize = computePrize(pot);
  const finished = await Tournament.findOneAndUpdate(
    { _id: tournamentId, status: 'playing' },
    { status: 'finished', winnerId, prize, settled: false, endedAt: new Date() },
    { new: true }
  );
  if (!finished) return;

  await settleTournament(tournamentId);
  // Estadísticas: todos suman un torneo jugado; el campeón, el torneo ganado y su ganancia neta
  const winnerEntrant = finished.entrants.find((e) => String(e.userId) === String(winnerId));
  const net = prize - (winnerEntrant?.paid || 0);
  await User.bulkWrite(finished.entrants.map((e) => {
    const isWinner = String(e.userId) === String(winnerId);
    const inc = { 'stats.tournamentsPlayed': 1 };
    if (isWinner) inc['stats.tournamentsWon'] = 1;
    if (isWinner && net > 0) inc['stats.chipsWon'] = net;
    return { updateOne: { filter: { _id: e.userId }, update: { $inc: inc } } };
  }));
  notifyTournament(await Tournament.findById(tournamentId).lean());
}

/**
 * Movimientos de fichas pendientes de un torneo terminado o cancelado: premio al campeón o devolución de
 * todas las inscripciones. Idempotente (claves por torneo e inscripción): se puede reintentar al arrancar.
 */
export async function settleTournament(tournamentId) {
  const t = await Tournament.findById(tournamentId).lean();
  if (!t || t.settled) return;
  if (t.status === 'finished' && t.prize > 0) {
    await payTournamentPrize(t._id, t.winnerId, t.prize);
  } else if (t.status === 'cancelled') {
    for (const e of t.entrants) {
      if (e.paid > 0) await refundTournamentEntry(t._id, e.userId, e.entryId, e.paid);
    }
  } else if (t.status !== 'finished') {
    return; // sigue en juego
  }
  await Tournament.updateOne({ _id: t._id, settled: false }, { settled: true });
  await notifyBalances(t.entrants.map((e) => e.userId));
}

// ─── Consultas ────────────────────────────────────────────

export async function getTournament(tournamentId) {
  const t = await Tournament.findById(tournamentId).lean();
  if (!t) throw notFound();
  return toPublicTournament(t);
}

/** El torneo en inscripción o en juego en el que sigue participando el usuario (sin estar eliminado). */
export async function getActiveTournament(userId) {
  const t = await Tournament.findOne({
    status: { $in: ['waiting', 'playing'] },
    entrants: { $elemMatch: { userId, eliminated: false } }
  }).lean();
  return t ? toPublicTournament(t) : null;
}

export async function listOpenTournaments({ size, minBuyIn, maxBuyIn }, { skip, limit }) {
  const filter = { status: 'waiting' };
  if (size) filter['config.size'] = size;
  if (minBuyIn !== undefined || maxBuyIn !== undefined) {
    filter['config.buyIn'] = {};
    if (minBuyIn !== undefined) filter['config.buyIn'].$gte = minBuyIn;
    if (maxBuyIn !== undefined) filter['config.buyIn'].$lte = maxBuyIn;
  }
  const [items, total] = await Promise.all([
    Tournament.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Tournament.countDocuments(filter)
  ]);
  return { items: items.map(toPublicTournament), total };
}

/** Nombres de las salas de torneo (para que la mesa muestre "Semifinal del torneo T…"). */
export async function describeTournamentRoom(roomId) {
  const room = await Room.findById(roomId).select('tournamentId').lean();
  if (!room?.tournamentId) return null;
  const t = await Tournament.findById(room.tournamentId).select('code config bracket').lean();
  const m = t?.bracket.find((x) => String(x.roomId) === String(roomId));
  return t && m ? { id: String(t._id), code: t.code, round: m.round, roundName: roundName(t.config.size, m.round) } : null;
}

// ─── Arranque del servidor ────────────────────────────────

/** Torneos en juego al reiniciar: se cancelan con devolución de inscripciones; se completan pagos pendientes. */
export async function recoverOnStartup() {
  const interrupted = await Tournament.updateMany(
    { status: 'playing' },
    { status: 'cancelled', settled: false, endedAt: new Date() }
  );
  if (interrupted.modifiedCount > 0) {
    console.warn(`Se cancelaron ${interrupted.modifiedCount} torneo(s) interrumpidos por el reinicio`);
  }
  const pending = await Tournament.find({ settled: false, status: { $in: ['finished', 'cancelled'] } }).select('_id').lean();
  for (const { _id } of pending) {
    try {
      await settleTournament(_id);
    } catch (err) {
      console.error(`No se pudieron liquidar las fichas del torneo ${_id}:`, err);
    }
  }
}

// ─── Solo tests ───────────────────────────────────────────

export function clearTimers() {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
}

// Las partidas de torneo que terminan avisan acá (matchService no importa este módulo: evita el ciclo)
matchService.onMatchFinished((summary) => {
  if (!summary.tournamentId) return;
  onMatchFinished(summary).catch((err) => {
    console.error(`Error al avanzar el torneo ${summary.tournamentId}:`, err);
  });
});
