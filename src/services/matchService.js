import { randomInt } from 'node:crypto';
import {
  PHASES, applyAction, createMatchState, dealNextHand, projectStateFor, shuffleDeck
} from '../game/truco/index.js';
import { Match } from '../models/Match.js';
import { MatchHandLog } from '../models/MatchHandLog.js';
import { Room } from '../models/Room.js';
import { User } from '../models/User.js';
import * as emitter from '../sockets/emitter.js';
import { AppError } from '../utils/AppError.js';

// Orquesta motor + persistencia + emisiones. Las partidas activas viven en memoria
// (una sola instancia del backend en la Fase 1) y se persiste el resultado de cada mano.
//
// Reinicio del servidor: las partidas que estaban en juego se CANCELAN (ver cancelInterruptedMatches).
// En M5 ese paso también reembolsa las apuestas bloqueadas.

export const settings = {
  nextHandDelayMs: 2500, // pausa para que se vea cómo terminó la mano antes del próximo reparto
  finishedTtlMs: 5 * 60 * 1000 // cuánto queda en memoria una partida terminada (para reconexiones tardías)
};
const MAX_REMEMBERED_ACTIONS = 200;

/** @type {Map<string, object>} matchId -> runtime */
const runtimes = new Map();

// ─── Ciclo de vida ────────────────────────────────────────

/** Arranca una partida ya persistida (Match en estado `playing`). */
export function startMatch({ match, room }) {
  const players = [...match.players].sort((a, b) => a.seat - b.seat).map((p) => ({
    id: String(p.userId),
    username: p.username
  }));

  const rt = {
    matchId: String(match._id),
    roomId: String(room._id),
    roomCode: room.code,
    players,
    state: createMatchState({
      config: { targetPoints: match.config.targetPoints },
      playerIds: players.map((p) => p.id),
      dealerSeat: randomInt(players.length)
    }),
    sockets: new Map(), // userId -> socketId (una conexión de juego por jugador)
    everConnected: new Set(), // para distinguir la primera conexión de una reconexión
    recentActionIds: [],
    handLog: null,
    timers: new Set(),
    finished: false
  };
  runtimes.set(rt.matchId, rt);
  dealHand(rt);
  return rt;
}

function dealHand(rt) {
  if (rt.finished) return;
  const { state, events } = dealNextHand(rt.state, shuffleDeck());
  rt.state = state;
  rt.handLog = {
    matchId: rt.matchId,
    handNumber: state.hand.number,
    manoId: state.players[state.hand.manoSeat].id,
    deck: state.hand.deck,
    dealt: state.hand.dealt,
    events: [],
    startedAt: new Date()
  };
  publish(rt, events);
}

function schedule(rt, fn, delayMs) {
  const timer = setTimeout(() => {
    rt.timers.delete(timer);
    fn();
  }, delayMs);
  rt.timers.add(timer);
}

// ─── Acciones ─────────────────────────────────────────────

/**
 * Aplica una intención de jugada. `actionId` (uuid del cliente) evita procesar dos veces
 * la misma acción si el cliente reintenta. Lanza RuleError/AppError si no es válida.
 */
export async function handleAction(userId, { matchId, actionId, type, payload }) {
  const rt = runtimes.get(matchId);
  if (!rt || rt.finished) throw new AppError('La partida no está activa', 404, 'MATCH_NOT_ACTIVE');
  if (!rt.players.some((p) => p.id === userId)) {
    throw new AppError('No sos parte de esta partida', 403, 'NOT_A_PLAYER');
  }
  if (rt.recentActionIds.includes(actionId)) return { duplicated: true };

  // El motor es síncrono: el estado se actualiza antes de cualquier await, así que dos
  // acciones que llegan juntas se procesan en orden y la segunda ve el estado nuevo.
  const { state, events } = applyAction(rt.state, userId, { type, payload });
  rt.recentActionIds.push(actionId);
  if (rt.recentActionIds.length > MAX_REMEMBERED_ACTIONS) rt.recentActionIds.shift();
  rt.state = state;
  rt.handLog.events.push({ action: type, playerId: userId, payload: payload ?? null, timestamp: new Date() });

  publish(rt, events);
  await afterTransition(rt);
  return { duplicated: false };
}

async function afterTransition(rt) {
  if (rt.state.phase === PHASES.HAND_OVER) {
    await persistHand(rt);
    schedule(rt, () => dealHand(rt), settings.nextHandDelayMs);
  } else if (rt.state.phase === PHASES.FINISHED) {
    await persistHand(rt);
    await finishMatch(rt);
  }
}

async function persistHand(rt) {
  const { state, handLog } = rt;
  try {
    await MatchHandLog.create({
      ...handLog,
      result: state.hand?.result ?? null,
      scoreAfter: [...state.score],
      endedAt: new Date()
    });
    await Match.updateOne({ _id: rt.matchId }, { score: [...state.score], handsPlayed: state.handNumber });
  } catch (err) {
    // La partida sigue aunque falle la auditoría: no castigamos a los jugadores por un error de base
    console.error(`No se pudo guardar la mano ${handLog.handNumber} de la partida ${rt.matchId}:`, err);
  }
}

async function finishMatch(rt) {
  rt.finished = true;
  for (const timer of rt.timers) clearTimeout(timer);
  rt.timers.clear();

  const { state } = rt;
  const endedAt = new Date();
  await Match.updateOne({ _id: rt.matchId }, {
    status: 'finished',
    score: [...state.score],
    winnerTeam: state.winnerTeam,
    endReason: state.endReason,
    endedAt
  });
  await Room.updateOne({ _id: rt.roomId }, { status: 'finished' });
  await User.bulkWrite(state.players.map((p) => ({
    updateOne: {
      filter: { _id: p.id },
      update: { $inc: { 'stats.played': 1, [p.team === state.winnerTeam ? 'stats.won' : 'stats.lost']: 1 } }
    }
  })));

  emitter.toMatch(rt.matchId, 'game:finished', buildFinishedSummary(rt));
  schedule(rt, () => runtimes.delete(rt.matchId), settings.finishedTtlMs);
}

// ─── Conexiones ───────────────────────────────────────────

/** Asocia el socket de un jugador a la partida (al entrar a la mesa o al reconectarse). */
export async function attachSocket(matchId, userId, socket) {
  const rt = runtimes.get(String(matchId));
  if (!rt) {
    const match = await Match.findById(matchId).lean();
    if (match?.status === 'finished') {
      socket.emit('game:finished', buildFinishedSummaryFromDoc(match));
      return;
    }
    throw new AppError('La partida ya no está activa', 404, 'MATCH_NOT_ACTIVE');
  }
  if (!rt.players.some((p) => p.id === userId)) {
    throw new AppError('No sos parte de esta partida', 403, 'NOT_A_PLAYER');
  }

  const previous = rt.sockets.get(userId);
  if (previous && previous !== socket.id) {
    // Una sola conexión de juego por jugador: la nueva pestaña reemplaza a la anterior
    emitter.toSocket(previous, 'game:error', {
      code: 'SESSION_REPLACED',
      message: 'Abriste esta partida en otra pestaña o dispositivo'
    });
    emitter.removeSocketFromRoom(previous, emitter.rooms.match(rt.matchId));
  }
  const wasAway = !previous;
  rt.sockets.set(userId, socket.id);
  socket.join(emitter.rooms.match(rt.matchId));
  socket.emit('game:state', buildStateFor(rt, userId));

  if (rt.finished) {
    socket.emit('game:finished', buildFinishedSummary(rt));
  } else if (wasAway && rt.everConnected.has(userId)) {
    emitter.toMatch(rt.matchId, 'player:reconnected', { playerId: userId });
  }
  rt.everConnected.add(userId);
}

/** Se desconectó un socket: avisa al rival. (La gracia de reconexión y el abandono llegan en M5.) */
export function detachSocket(userId, socketId) {
  for (const rt of runtimes.values()) {
    if (rt.sockets.get(userId) !== socketId) continue;
    rt.sockets.delete(userId);
    if (!rt.finished) {
      emitter.toMatch(rt.matchId, 'player:disconnected', { playerId: userId, graceSeconds: null });
    }
  }
}

// ─── Proyecciones ─────────────────────────────────────────

function publish(rt, events) {
  // Los eventos del motor son públicos (cartas jugadas, cantos, tantos anunciados)
  for (const event of events) emitter.toMatch(rt.matchId, 'game:event', event);
  // El estado se envía proyectado a cada jugador por separado: nunca un broadcast del estado completo
  for (const p of rt.players) {
    const socketId = rt.sockets.get(p.id);
    if (socketId) emitter.toSocket(socketId, 'game:state', buildStateFor(rt, p.id));
  }
}

export function buildStateFor(rt, userId) {
  return {
    matchId: rt.matchId,
    roomId: rt.roomId,
    roomCode: rt.roomCode,
    usernames: Object.fromEntries(rt.players.map((p) => [p.id, p.username])),
    ...projectStateFor(rt.state, userId)
  };
}

function buildFinishedSummary(rt) {
  const { state } = rt;
  return {
    matchId: rt.matchId,
    winnerTeam: state.winnerTeam,
    winnerIds: state.players.filter((p) => p.team === state.winnerTeam).map((p) => p.id),
    score: [...state.score],
    endReason: state.endReason,
    chips: null // M5: movimiento de fichas de la apuesta
  };
}

function buildFinishedSummaryFromDoc(match) {
  return {
    matchId: String(match._id),
    winnerTeam: match.winnerTeam,
    winnerIds: match.players.filter((p) => p.team === match.winnerTeam).map((p) => String(p.userId)),
    score: match.score,
    endReason: match.endReason,
    chips: null
  };
}

// ─── Arranque del servidor ────────────────────────────────

/**
 * Al reiniciar, las partidas en memoria se pierden: se cancelan las que quedaron en juego.
 * (Política elegida: cancelar en vez de restaurar; en M5 incluye reembolsar las apuestas.)
 */
export async function cancelInterruptedMatches() {
  const interrupted = await Match.find({ status: 'playing' }).select('_id roomId').lean();
  if (interrupted.length === 0) return 0;
  const now = new Date();
  await Match.updateMany(
    { _id: { $in: interrupted.map((m) => m._id) } },
    { status: 'cancelled', endReason: 'cancelled', endedAt: now }
  );
  await Room.updateMany({ _id: { $in: interrupted.map((m) => m.roomId) } }, { status: 'cancelled' });
  console.warn(`Se cancelaron ${interrupted.length} partida(s) interrumpidas por el reinicio`);
  return interrupted.length;
}

// ─── Solo tests ───────────────────────────────────────────

export function getRuntime(matchId) {
  return runtimes.get(String(matchId));
}

export function clearRuntimes() {
  for (const rt of runtimes.values()) for (const timer of rt.timers) clearTimeout(timer);
  runtimes.clear();
}
