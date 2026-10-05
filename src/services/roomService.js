import { randomInt, randomUUID } from 'node:crypto';
import { Match } from '../models/Match.js';
import { ACTIVE_ROOM_STATUSES, Room } from '../models/Room.js';
import { Tournament } from '../models/Tournament.js';
import * as emitter from '../sockets/emitter.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { runInTransaction } from '../utils/transaction.js';
import { notifyBalances } from './betService.js';
import * as matchService from './matchService.js';
import { getBalance, lockBet } from './walletService.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I para que se lea bien
const CODE_LENGTH = 6;
const LOBBY_LIMIT = 50;

function generateCode() {
  return Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

export function toPublicRoom(room) {
  return {
    id: String(room._id),
    code: room.code,
    hostId: String(room.hostId),
    config: {
      targetPoints: room.config.targetPoints,
      withFlor: room.config.withFlor,
      isPrivate: Boolean(room.config.isPrivate),
      bet: room.config.bet
    },
    seats: room.seats.map((s) => ({ userId: String(s.userId), username: s.username })),
    status: room.status,
    cancelReason: room.cancelReason || null,
    matchId: room.matchId ? String(room.matchId) : null,
    tournamentId: room.tournamentId ? String(room.tournamentId) : null,
    rematchOf: room.rematchOf ? String(room.rematchOf) : null,
    createdAt: room.createdAt
  };
}

/**
 * Un usuario hace una sola cosa a la vez: una sala en espera o partida en juego, o un torneo en el que
 * sigue participando (inscripción abierta o en juego sin estar eliminado).
 */
export async function assertUserIsFree(userId) {
  const active = await Room.exists({ 'seats.userId': userId, status: { $in: ACTIVE_ROOM_STATUSES } });
  if (active) {
    throw new AppError('Ya estás en una mesa. Terminala o cancelala antes de entrar a otra.', 409, 'ALREADY_IN_ROOM');
  }
  const inTournament = await Tournament.exists({
    status: { $in: ['waiting', 'playing'] },
    entrants: { $elemMatch: { userId, eliminated: false } }
  });
  if (inTournament) {
    throw new AppError('Estás anotado en un torneo: terminalo o salí antes de entrar a otra mesa.', 409, 'ALREADY_IN_TOURNAMENT');
  }
}

// ─── Notificaciones ───────────────────────────────────────

export async function listLobbyRooms() {
  const rooms = await Room.find({ status: 'waiting', 'config.isPrivate': { $ne: true } })
    .sort({ createdAt: -1 }).limit(LOBBY_LIMIT).lean();
  return rooms.map(toPublicRoom);
}

async function notifyLobby() {
  try {
    emitter.toLobby('lobby:rooms', await listLobbyRooms());
  } catch (err) {
    console.error('No se pudo actualizar el lobby:', err);
  }
}

function notifyRoom(room) {
  const data = toPublicRoom(room);
  for (const seat of room.seats) emitter.toUser(String(seat.userId), 'room:update', data);
}

// ─── Operaciones ──────────────────────────────────────────

/** Crea una sala. Idempotente por `uuid`: reintentar devuelve la misma sala. */
export async function createRoom(user, { uuid, targetPoints, bet, isPrivate = false }) {
  const existing = await Room.findOne({ uuid, hostId: user.id }).lean();
  if (existing) return toPublicRoom(existing);

  await assertUserIsFree(user.id);
  // P5: tope propio en salas privadas (evita pasar fichas entre cuentas)
  const privateMax = Math.min(env.privateMaxBet, env.maxBet);
  if (isPrivate && bet > privateMax) {
    throw new AppError(`En salas privadas la apuesta máxima es de ${privateMax} fichas`, 400, 'PRIVATE_BET_TOO_HIGH');
  }
  // Con apuesta: solo se verifica el saldo; las fichas se bloquean cuando se completa la mesa
  if (bet > 0 && (await getBalance(user.id)) < bet) {
    throw new AppError('No tenés fichas suficientes para esa apuesta', 400, 'INSUFFICIENT_BALANCE');
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const room = await Room.create({
        code: generateCode(),
        hostId: user.id,
        config: { targetPoints, withFlor: false, isPrivate: Boolean(isPrivate), bet, maxPlayers: 2 },
        seats: [{ userId: user.id, username: user.username }],
        status: 'waiting',
        uuid
      });
      if (!room.config.isPrivate) await notifyLobby(); // una sala privada no se ve en el lobby
      return toPublicRoom(room);
    } catch (err) {
      if (err?.code !== 11000) throw err;
      if (err.keyPattern?.uuid) {
        const again = await Room.findOne({ uuid, hostId: user.id }).lean();
        if (again) return toPublicRoom(again);
        throw new AppError('Identificador de sala repetido', 409, 'CONFLICT');
      }
      // código repetido: se reintenta con otro
    }
  }
  throw new AppError('No se pudo crear la sala, probá de nuevo', 500, 'ROOM_CODE_EXHAUSTED');
}

/**
 * Se suma a una sala en espera. Al completarse, la sala pasa a `playing` y arranca la partida.
 * Una sala privada solo se abre con su código (`viaCode`): conocer el id no alcanza.
 */
export async function joinRoom(user, roomId, { viaCode = false } = {}) {
  const current = await Room.findById(roomId).lean();
  if (!current || (current.config.isPrivate && !viaCode)) throw new AppError('La sala no existe', 404, 'NOT_FOUND');
  if (String(current.hostId) === user.id) {
    throw new AppError('No podés unirte a tu propia sala', 400, 'CANNOT_JOIN_OWN_ROOM');
  }
  if (current.status !== 'waiting') {
    throw new AppError('La sala ya no está disponible', 409, 'ROOM_NOT_AVAILABLE');
  }
  await assertUserIsFree(user.id);
  const bet = current.config.bet || 0;
  if (bet > 0 && (await getBalance(user.id)) < bet) {
    throw new AppError('No tenés fichas suficientes para esta mesa', 400, 'INSUFFICIENT_BALANCE');
  }

  // Ocupar el asiento, crear la partida y bloquear las apuestas de ambos en UNA transacción:
  // si falla cualquier paso (por ejemplo, el saldo de alguno), no se bloquea nada.
  const { room, match } = await runInTransaction(async (session) => {
    const updated = await Room.findOneAndUpdate(
      { _id: roomId, status: 'waiting', 'seats.1': { $exists: false }, 'seats.userId': { $ne: user.id } },
      { $push: { seats: { userId: user.id, username: user.username } }, $set: { status: 'playing' } },
      { new: true, session }
    );
    if (!updated) throw new AppError('La sala ya no está disponible', 409, 'ROOM_NOT_AVAILABLE');

    const created = await createMatchForRoom(updated, session, {
      onInsufficient: (userId) => (userId === user.id
        ? new AppError('No tenés fichas suficientes para esta mesa', 400, 'INSUFFICIENT_BALANCE')
        : new AppError('El anfitrión ya no tiene fichas suficientes para esta mesa', 409, 'HOST_INSUFFICIENT_BALANCE'))
    });
    return { room: updated, match: created };
  });

  matchService.startMatch({ room, match });
  notifyRoom(room);
  await notifyLobby();
  if (room.config.bet > 0) await notifyBalances(room.seats.map((s) => s.userId));
  return toPublicRoom(room);
}

/**
 * Crea la partida de una sala completa y bloquea las apuestas de todos, dentro de `session`.
 * Si a alguno no le alcanza el saldo, lanza el error que arme `onInsufficient(userId)` (y no se bloquea nada).
 */
async function createMatchForRoom(room, session, { onInsufficient, tournamentId = null, round = null } = {}) {
  const bet = room.config.bet || 0;
  const [match] = await Match.create([{
    roomId: room._id,
    config: { targetPoints: room.config.targetPoints, withFlor: room.config.withFlor, isPrivate: Boolean(room.config.isPrivate), bet },
    players: room.seats.map((s, seat) => ({
      userId: s.userId, username: s.username, seat, team: seat % 2, betLocked: bet
    })),
    status: 'playing',
    betsSettled: !(bet > 0),
    tournamentId,
    round,
    startedAt: new Date()
  }], { session });

  if (bet > 0) {
    for (const seat of room.seats) {
      try {
        await lockBet(match._id, seat.userId, bet, { session });
      } catch (err) {
        if (err?.code !== 'INSUFFICIENT_BALANCE' || !onInsufficient) throw err;
        throw onInsufficient(String(seat.userId));
      }
    }
  }

  room.matchId = match._id;
  await room.save({ session });
  return match;
}

/** Inserta una sala que arranca directamente en juego (revancha o torneo), reintentando si el código se repite. */
async function createPlayingRoom(data, buildMatch) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await runInTransaction(async (session) => {
        const [room] = await Room.create([{ ...data, code: generateCode(), status: 'playing' }], { session });
        const match = await buildMatch(room, session);
        return { room, match };
      });
    } catch (err) {
      if (err?.code !== 11000 || err.keyPattern?.uuid) throw err;
      // código repetido: se reintenta con otro
    }
  }
  throw new AppError('No se pudo crear la sala, probá de nuevo', 500, 'ROOM_CODE_EXHAUSTED');
}

/**
 * Revancha: sala nueva con la misma configuración y los mismos jugadores; las apuestas se bloquean
 * de nuevo en una sola transacción (si a alguno no le alcanza, no arranca).
 */
export async function createRematchRoom(previousRoomId, players) {
  const previous = await Room.findById(previousRoomId).lean();
  if (!previous) throw new AppError('La sala no existe', 404, 'NOT_FOUND');
  for (const p of players) await assertUserIsFree(p.id);

  const { room, match } = await createPlayingRoom({
    hostId: players[0].id,
    config: {
      targetPoints: previous.config.targetPoints, withFlor: false, isPrivate: Boolean(previous.config.isPrivate), bet: previous.config.bet, maxPlayers: 2
    },
    seats: players.map((p) => ({ userId: p.id, username: p.username })),
    rematchOf: previous._id,
    uuid: randomUUID()
  }, (newRoom, session) => createMatchForRoom(newRoom, session, {
    onInsufficient: (userId) => new AppError(
      `${players.find((p) => p.id === userId)?.username || 'Un jugador'} no tiene fichas suficientes para la revancha`,
      409,
      'REMATCH_INSUFFICIENT_BALANCE'
    )
  }));

  matchService.startMatch({ room, match });
  if (room.config.bet > 0) await notifyBalances(room.seats.map((s) => s.userId));
  return toPublicRoom(room);
}

/**
 * Sala y partida de una llave de torneo (sin apuesta propia). Idempotente por llave: si ya existe,
 * devuelve null y no crea nada.
 */
export async function createTournamentRoom({ tournament, round, slot, players }) {
  const uuid = `tournament:${tournament._id}:${round}:${slot}`;
  if (await Room.exists({ uuid })) return null;
  try {
    const { room, match } = await createPlayingRoom({
      hostId: players[0].userId,
      config: { targetPoints: tournament.config.targetPoints, withFlor: false, bet: 0, maxPlayers: 2 },
      seats: players.map((p) => ({ userId: p.userId, username: p.username })),
      tournamentId: tournament._id,
      uuid
    }, (newRoom, session) => createMatchForRoom(newRoom, session, { tournamentId: tournament._id, round }));
    matchService.startMatch({ room, match });
    return { room, match };
  } catch (err) {
    if (err?.code === 11000 && err.keyPattern?.uuid) return null; // otra llamada la creó en paralelo
    throw err;
  }
}

const ROOM_CODE_NOT_FOUND = () => new AppError(
  'No encontramos una sala abierta con ese código. Revisalo o pedile uno nuevo a quien la creó.', 404, 'ROOM_CODE_NOT_FOUND'
);

/** Datos de una sala en espera a partir de su código, para mostrar a qué se va a unir el jugador. */
export async function getRoomByCode(code) {
  const room = await Room.findOne({ code, status: 'waiting' }).lean();
  if (!room) throw ROOM_CODE_NOT_FOUND();
  return toPublicRoom(room);
}

/** Unirse con el código (salas privadas o públicas). */
export async function joinRoomByCode(user, code) {
  const room = await Room.findOne({ code, status: 'waiting' }).select('_id').lean();
  if (!room) throw ROOM_CODE_NOT_FOUND();
  return joinRoom(user, room._id, { viaCode: true });
}

/** Cancela una sala propia que todavía está en espera. */
export async function cancelRoom(user, roomId) {
  const room = await Room.findOneAndUpdate(
    { _id: roomId, hostId: user.id, status: 'waiting' },
    { status: 'cancelled' },
    { new: true }
  );
  if (!room) {
    const exists = await Room.exists({ _id: roomId, hostId: user.id });
    if (!exists) throw new AppError('La sala no existe', 404, 'NOT_FOUND');
    throw new AppError('La partida ya empezó: no se puede cancelar', 409, 'ROOM_NOT_CANCELLABLE');
  }
  notifyRoom(room);
  await notifyLobby();
  return toPublicRoom(room);
}

/**
 * P6: cancela las salas que siguen en espera sin rival después de ROOM_WAITING_TTL_MINUTES.
 * Mientras esperan no hay fichas bloqueadas, así que no hay nada que devolver. Devuelve cuántas venció.
 */
export async function expireWaitingRooms(now = new Date()) {
  const limit = new Date(now.getTime() - env.roomWaitingTtlMinutes * 60 * 1000);
  const stale = await Room.find({ status: 'waiting', createdAt: { $lte: limit } }).select('_id').lean();
  let expired = 0;
  let publicChanged = false;
  for (const { _id } of stale) {
    // Condicionado a 'waiting': si justo entró un rival, no se toca
    const room = await Room.findOneAndUpdate({ _id, status: 'waiting' }, { status: 'cancelled', cancelReason: 'expired' }, { new: true });
    if (!room) continue;
    expired += 1;
    if (!room.config.isPrivate) publicChanged = true;
    notifyRoom(room);
  }
  if (publicChanged) await notifyLobby();
  return expired;
}

/** Sala visible para un jugador sentado en ella (para la mesa y las reconexiones). */
export async function getRoomForPlayer(userId, roomId) {
  const room = await Room.findById(roomId).lean();
  if (!room) throw new AppError('La sala no existe', 404, 'NOT_FOUND');
  if (!room.seats.some((s) => String(s.userId) === userId)) {
    throw new AppError('No estás sentado en esta mesa', 403, 'NOT_IN_ROOM');
  }
  return toPublicRoom(room);
}

/** La sala en espera o en juego del usuario, si tiene una. */
export async function getActiveRoom(userId) {
  const room = await Room.findOne({ 'seats.userId': userId, status: { $in: ACTIVE_ROOM_STATUSES } }).lean();
  return room ? toPublicRoom(room) : null;
}

export async function listOpenRooms({ targetPoints, minBet, maxBet }, { skip, limit }) {
  const filter = { status: 'waiting', 'config.isPrivate': { $ne: true } };
  if (targetPoints) filter['config.targetPoints'] = targetPoints;
  if (minBet !== undefined || maxBet !== undefined) {
    filter['config.bet'] = {};
    if (minBet !== undefined) filter['config.bet'].$gte = minBet;
    if (maxBet !== undefined) filter['config.bet'].$lte = maxBet;
  }
  const [items, total] = await Promise.all([
    Room.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Room.countDocuments(filter)
  ]);
  return { items: items.map(toPublicRoom), total };
}
