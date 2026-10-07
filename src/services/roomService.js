import { randomInt, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
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

/** Asientos con su número (las salas viejas no lo guardan: vale el orden del array). */
function seatsOf(room) {
  return room.seats.map((s, i) => ({ userId: s.userId, username: s.username, seat: s.seat ?? i }));
}

const maxPlayersOf = (room) => room.config.maxPlayers || (room.config.mode === '2v2' ? 4 : 2);

export function toPublicRoom(room) {
  return {
    id: String(room._id),
    code: room.code,
    hostId: String(room.hostId),
    config: {
      targetPoints: room.config.targetPoints,
      withFlor: room.config.withFlor,
      isPrivate: Boolean(room.config.isPrivate),
      mode: room.config.mode || '1v1',
      maxPlayers: maxPlayersOf(room),
      bet: room.config.bet
    },
    // Equipo por asiento: 0 = A (asientos 0 y 2), 1 = B (asientos 1 y 3)
    seats: seatsOf(room).sort((a, b) => a.seat - b.seat)
      .map((x) => ({ userId: String(x.userId), username: x.username, seat: x.seat, team: x.seat % 2 })),
    status: room.status,
    readyIds: (room.readyIds || []).map(String),
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
export async function createRoom(user, { uuid, targetPoints, bet, isPrivate = false, mode = '1v1' }) {
  const existing = await Room.findOne({ uuid, hostId: user.id }).lean();
  if (existing) return toPublicRoom(existing);

  await assertUserIsFree(user.id);
  // P5: tope propio en salas privadas (evita pasar fichas entre cuentas)
  const privateMax = Math.min(env.privateMaxBet, env.maxBet);
  if (isPrivate && bet > privateMax) {
    throw new AppError(`En salas privadas la apuesta máxima es de ${privateMax} fichas`, 400, 'PRIVATE_BET_TOO_HIGH');
  }
  // 2 vs 2: múltiplo de 10 para poder repartir sin decimales cuando alguien abandona (cada rival cobra 1,5 apuestas)
  if (mode === '2v2' && bet % 10 !== 0) {
    throw new AppError('En 2 vs 2 la apuesta tiene que ser múltiplo de 10', 400, 'BET_NOT_MULTIPLE_OF_10');
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
        config: { targetPoints, withFlor: false, isPrivate: Boolean(isPrivate), mode, bet, maxPlayers: mode === '2v2' ? 4 : 2 },
        seats: [{ userId: user.id, username: user.username, seat: 0 }],
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
 * Se suma a una sala en espera, en el asiento pedido (o en el primero libre). Cuando se ocupa el último
 * asiento, la sala pasa a `playing` y en la MISMA transacción se crea la partida y se bloquean las apuestas
 * de todos: si a alguno no le alcanza, no se bloquea nada y la sala sigue en espera.
 * Una sala privada solo se abre con su código (`viaCode`): conocer el id no alcanza.
 */
export async function joinRoom(user, roomId, { viaCode = false, seat = null } = {}) {
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

  const max = maxPlayersOf(current);
  const taken = seatsOf(current).map((x) => x.seat);
  if (seat !== null && (seat < 0 || seat >= max)) throw new AppError('Ese asiento no existe', 400, 'INVALID_SEAT');
  const target = seat ?? [...Array(max).keys()].find((k) => !taken.includes(k));
  if (target === undefined) throw new AppError('La sala ya no está disponible', 409, 'ROOM_NOT_AVAILABLE');
  if (taken.includes(target)) throw new AppError('Ese asiento ya está ocupado', 409, 'SEAT_TAKEN');

  const { room, match } = await runInTransaction(async (session) => {
    // Condiciones atómicas: sigue en espera, queda lugar, el usuario no está y el asiento sigue libre
    const updated = await Room.findOneAndUpdate(
      {
        _id: roomId,
        status: 'waiting',
        [`seats.${max - 1}`]: { $exists: false },
        'seats.userId': { $ne: user.id },
        seats: { $not: { $elemMatch: { seat: target } } }
      },
      { $push: { seats: { userId: user.id, username: user.username, seat: target } } },
      { new: true, session }
    );
    if (!updated) throw new AppError('La sala ya no está disponible o ese asiento se ocupó', 409, 'ROOM_NOT_AVAILABLE');
    if (updated.seats.length < max) return { room: updated, match: null };
    // 2 vs 2: con los 4 lugares ocupados se espera la confirmación de todos (confirmReady)
    if (max === 4) return { room: updated, match: null };

    updated.status = 'playing';
    const created = await createMatchForRoom(updated, session, {
      onInsufficient: (userId) => {
        if (userId === user.id) return new AppError('No tenés fichas suficientes para esta mesa', 400, 'INSUFFICIENT_BALANCE');
        if (max === 2) return new AppError('El anfitrión ya no tiene fichas suficientes para esta mesa', 409, 'HOST_INSUFFICIENT_BALANCE');
        const name = updated.seats.find((x) => String(x.userId) === userId)?.username || 'Un jugador';
        return new AppError(`${name} ya no tiene fichas suficientes para esta mesa`, 409, 'PLAYER_INSUFFICIENT_BALANCE');
      }
    });
    return { room: updated, match: created };
  });

  if (match) matchService.startMatch({ room, match });
  notifyRoom(room);
  if (!room.config.isPrivate) await notifyLobby();
  if (match && room.config.bet > 0) await notifyBalances(room.seats.map((x) => x.userId));
  return toPublicRoom(room);
}

const startFailedMessage = (room, userId) => {
  const name = room.seats.find((x) => String(x.userId) === userId)?.username || 'Un jugador';
  return new AppError(`${name} ya no tiene fichas suficientes para esta mesa`, 409, 'PLAYER_INSUFFICIENT_BALANCE');
};

/**
 * 2 vs 2: con los 4 lugares ocupados, cada uno confirma "Estoy listo". Cuando confirman los 4, en UNA
 * transacción la sala pasa a `playing`, se crea la partida y se bloquean las 4 apuestas. Si a alguno ya no le
 * alcanza, no arranca, se borran las confirmaciones y se avisa a la mesa.
 */
export async function confirmReady(user, roomId) {
  const current = await Room.findOne({ _id: roomId, 'seats.userId': user.id }).lean();
  if (!current) throw new AppError('No estás sentado en esta mesa', 403, 'NOT_IN_ROOM');
  if (current.status !== 'waiting') throw new AppError('La partida ya empezó', 409, 'ROOM_NOT_AVAILABLE');
  if ((current.config.mode || '1v1') !== '2v2') throw new AppError('Solo en 2 vs 2 hay que confirmar', 400, 'READY_NOT_ALLOWED');
  if (current.seats.length < maxPlayersOf(current)) {
    throw new AppError('Todavía faltan jugadores', 409, 'ROOM_NOT_FULL');
  }
  const bet = current.config.bet || 0;
  if (bet > 0 && (await getBalance(user.id)) < bet) {
    throw new AppError('No tenés fichas suficientes para esta mesa', 400, 'INSUFFICIENT_BALANCE');
  }

  const me = new mongoose.Types.ObjectId(user.id);
  let room = await Room.findOneAndUpdate(
    { _id: roomId, status: 'waiting', 'seats.3': { $exists: true }, 'seats.userId': me },
    { $addToSet: { readyIds: me } },
    { new: true }
  );
  if (!room) throw new AppError('La sala ya no está disponible', 409, 'ROOM_NOT_AVAILABLE');
  if (room.readyIds.length < room.seats.length) {
    notifyRoom(room);
    return toPublicRoom(room);
  }

  // Confirmaron los 4: arranca (solo una de las llamadas concurrentes lo logra)
  let match = null;
  try {
    ({ room, match } = await runInTransaction(async (session) => {
      const started = await Room.findOneAndUpdate(
        { _id: roomId, status: 'waiting', readyIds: { $size: room.seats.length } },
        { $set: { status: 'playing' } },
        { new: true, session }
      );
      if (!started) return { room, match: null };
      const created = await createMatchForRoom(started, session, { onInsufficient: (userId) => startFailedMessage(started, userId) });
      return { room: started, match: created };
    }));
  } catch (err) {
    if (err?.code !== 'PLAYER_INSUFFICIENT_BALANCE') throw err;
    // No arrancó: se borran las confirmaciones para que vuelvan a confirmar (o salga el que no tiene fichas)
    const reset = await Room.findOneAndUpdate({ _id: roomId, status: 'waiting' }, { $set: { readyIds: [] } }, { new: true });
    if (reset) notifyRoom(reset);
    for (const seat of current.seats) emitter.toUser(String(seat.userId), 'room:error', { roomId: String(roomId), message: err.message });
    throw err;
  }
  if (!match) return toPublicRoom(await Room.findById(roomId).lean());

  matchService.startMatch({ room, match });
  notifyRoom(room);
  if (!room.config.isPrivate) await notifyLobby();
  if (room.config.bet > 0) await notifyBalances(room.seats.map((x) => x.userId));
  return toPublicRoom(room);
}

/** 2 vs 2: cambiarse a un asiento libre mientras la sala está en espera. */
export async function changeSeat(user, roomId, seat) {
  const current = await Room.findOne({ _id: roomId, 'seats.userId': user.id }).lean();
  if (!current) throw new AppError('No estás sentado en esta mesa', 403, 'NOT_IN_ROOM');
  if (current.status !== 'waiting') throw new AppError('La partida ya empezó', 409, 'ROOM_NOT_AVAILABLE');
  if ((current.config.mode || '1v1') !== '2v2') throw new AppError('Solo se cambia de asiento en 2 vs 2', 400, 'SEAT_CHANGE_NOT_ALLOWED');
  if (seat < 0 || seat >= maxPlayersOf(current)) throw new AppError('Ese asiento no existe', 400, 'INVALID_SEAT');

  const me = new mongoose.Types.ObjectId(user.id);
  const room = await Room.findOneAndUpdate(
    { _id: roomId, status: 'waiting', 'seats.userId': me, seats: { $not: { $elemMatch: { seat } } } },
    { $set: { 'seats.$[me].seat': seat, readyIds: [] } },
    { new: true, arrayFilters: [{ 'me.userId': me }] }
  );
  if (!room) throw new AppError('Ese asiento ya está ocupado', 409, 'SEAT_TAKEN');
  notifyRoom(room);
  if (!room.config.isPrivate) await notifyLobby();
  return toPublicRoom(room);
}

/**
 * Salir de una sala en espera: libera el asiento. Si sale el anfitrión y quedan otros, pasa a ser
 * anfitrión el que sigue (por asiento); si no queda nadie, la sala se cancela.
 */
export async function leaveRoom(user, roomId) {
  const current = await Room.findOne({ _id: roomId, 'seats.userId': user.id }).lean();
  if (!current) throw new AppError('No estás sentado en esta mesa', 403, 'NOT_IN_ROOM');
  if (current.status !== 'waiting') throw new AppError('La partida ya empezó: no se puede salir', 409, 'ROOM_NOT_AVAILABLE');

  const others = seatsOf(current).filter((x) => String(x.userId) !== user.id).sort((a, b) => a.seat - b.seat);
  const me = new mongoose.Types.ObjectId(user.id);
  const update = others.length === 0
    ? { $set: { status: 'cancelled' } }
    // Si alguien sale, se borran las confirmaciones: el que entre después tiene que confirmar con todos
    : { $pull: { seats: { userId: me } }, $set: { readyIds: [], ...(String(current.hostId) === user.id ? { hostId: others[0].userId } : {}) } };
  const room = await Room.findOneAndUpdate({ _id: roomId, status: 'waiting', 'seats.userId': me }, update, { new: true });
  if (!room) throw new AppError('La partida ya empezó: no se puede salir', 409, 'ROOM_NOT_AVAILABLE');

  notifyRoom(room);
  emitter.toUser(user.id, 'room:update', { ...toPublicRoom(room), left: true });
  if (!room.config.isPrivate) await notifyLobby();
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
    config: {
      targetPoints: room.config.targetPoints,
      withFlor: room.config.withFlor,
      isPrivate: Boolean(room.config.isPrivate),
      mode: room.config.mode || '1v1',
      bet
    },
    players: seatsOf(room).sort((a, b) => a.seat - b.seat).map((x) => ({
      userId: x.userId, username: x.username, seat: x.seat, team: x.seat % 2, betLocked: bet
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
      targetPoints: previous.config.targetPoints,
      withFlor: false,
      isPrivate: Boolean(previous.config.isPrivate),
      mode: previous.config.mode || '1v1',
      bet: previous.config.bet,
      maxPlayers: maxPlayersOf(previous)
    },
    seats: players.map((p, seat) => ({ userId: p.id, username: p.username, seat })),
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
      seats: players.map((p, seat) => ({ userId: p.userId, username: p.username, seat })),
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
export async function joinRoomByCode(user, code, { seat = null } = {}) {
  const room = await Room.findOne({ code, status: 'waiting' }).select('_id').lean();
  if (!room) throw ROOM_CODE_NOT_FOUND();
  return joinRoom(user, room._id, { viaCode: true, seat });
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

export async function listOpenRooms({ targetPoints, mode, minBet, maxBet }, { skip, limit }) {
  const filter = { status: 'waiting', 'config.isPrivate': { $ne: true } };
  if (targetPoints) filter['config.targetPoints'] = targetPoints;
  // Las salas viejas no tienen modo: son 1 vs 1
  if (mode === '2v2') filter['config.mode'] = '2v2';
  else if (mode === '1v1') filter['config.mode'] = { $ne: '2v2' };
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
