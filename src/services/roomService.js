import { randomInt } from 'node:crypto';
import { Match } from '../models/Match.js';
import { ACTIVE_ROOM_STATUSES, Room } from '../models/Room.js';
import * as emitter from '../sockets/emitter.js';
import { AppError } from '../utils/AppError.js';
import { runInTransaction } from '../utils/transaction.js';
import * as matchService from './matchService.js';

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
      bet: room.config.bet
    },
    seats: room.seats.map((s) => ({ userId: String(s.userId), username: s.username })),
    status: room.status,
    matchId: room.matchId ? String(room.matchId) : null,
    createdAt: room.createdAt
  };
}

async function assertNoActiveRoom(userId) {
  const active = await Room.exists({ 'seats.userId': userId, status: { $in: ACTIVE_ROOM_STATUSES } });
  if (active) {
    throw new AppError('Ya estás en una mesa. Terminala o cancelala antes de entrar a otra.', 409, 'ALREADY_IN_ROOM');
  }
}

// ─── Notificaciones ───────────────────────────────────────

export async function listLobbyRooms() {
  const rooms = await Room.find({ status: 'waiting' }).sort({ createdAt: -1 }).limit(LOBBY_LIMIT).lean();
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
export async function createRoom(user, { uuid, targetPoints, bet }) {
  const existing = await Room.findOne({ uuid, hostId: user.id }).lean();
  if (existing) return toPublicRoom(existing);

  if (bet > 0) {
    // M5: verificar saldo del host (sin bloquear) y habilitar las mesas con apuesta
    throw new AppError('Las mesas con apuesta llegan muy pronto. Por ahora solo hay mesas gratis.', 400, 'BETS_NOT_AVAILABLE');
  }
  await assertNoActiveRoom(user.id);

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const room = await Room.create({
        code: generateCode(),
        hostId: user.id,
        config: { targetPoints, withFlor: false, bet, maxPlayers: 2 },
        seats: [{ userId: user.id, username: user.username }],
        status: 'waiting',
        uuid
      });
      await notifyLobby();
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

/** Se suma a una sala en espera. Al completarse, la sala pasa a `playing` y arranca la partida. */
export async function joinRoom(user, roomId) {
  const current = await Room.findById(roomId).lean();
  if (!current) throw new AppError('La sala no existe', 404, 'NOT_FOUND');
  if (String(current.hostId) === user.id) {
    throw new AppError('No podés unirte a tu propia sala', 400, 'CANNOT_JOIN_OWN_ROOM');
  }
  if (current.status !== 'waiting') {
    throw new AppError('La sala ya no está disponible', 409, 'ROOM_NOT_AVAILABLE');
  }
  await assertNoActiveRoom(user.id);

  // Ocupar el asiento y crear la partida en una sola transacción.
  // M5: acá mismo se bloquean las apuestas de ambos con walletService.lockBet(..., { session }).
  const { room, match } = await runInTransaction(async (session) => {
    const updated = await Room.findOneAndUpdate(
      { _id: roomId, status: 'waiting', 'seats.1': { $exists: false }, 'seats.userId': { $ne: user.id } },
      { $push: { seats: { userId: user.id, username: user.username } }, $set: { status: 'playing' } },
      { new: true, session }
    );
    if (!updated) throw new AppError('La sala ya no está disponible', 409, 'ROOM_NOT_AVAILABLE');

    const [created] = await Match.create([{
      roomId: updated._id,
      config: {
        targetPoints: updated.config.targetPoints,
        withFlor: updated.config.withFlor,
        bet: updated.config.bet
      },
      players: updated.seats.map((s, seat) => ({
        userId: s.userId, username: s.username, seat, team: seat % 2, betLocked: 0
      })),
      status: 'playing',
      startedAt: new Date()
    }], { session });

    updated.matchId = created._id;
    await updated.save({ session });
    return { room: updated, match: created };
  });

  matchService.startMatch({ room, match });
  notifyRoom(room);
  await notifyLobby();
  return toPublicRoom(room);
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
  const filter = { status: 'waiting' };
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
