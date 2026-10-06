import { randomInt } from 'node:crypto';
import { env } from '../config/env.js';
import {
  PHASES, applyAction, applyTimeout, createMatchState, dealNextHand, forfeitMatch,
  getActingPlayerIds, projectStateFor, shuffleDeck
} from '../game/truco/index.js';
import { Match } from '../models/Match.js';
import { MatchHandLog } from '../models/MatchHandLog.js';
import { Room } from '../models/Room.js';
import { User } from '../models/User.js';
import * as emitter from '../sockets/emitter.js';
import { AppError } from '../utils/AppError.js';
import { buildChipsSummary, settleMatchBets, settlePendingBets } from './betService.js';

// Orquesta motor + apuestas + persistencia + timers + emisiones. Las partidas activas viven en
// memoria (una sola instancia del backend en la Fase 1) y se persiste el resultado de cada mano.
//
// Timers (el motor no conoce el reloj):
//  - Turno: TURN_TIMEOUT_SECONDS por decisión. Al vencer, `applyTimeout` (no quiero / pierde la mano).
//    Se pausa mientras quien tiene que actuar está desconectado: ahí corre la gracia de reconexión.
//  - Gracia de reconexión: RECONNECT_GRACE_SECONDS. Si no vuelve, pierde la partida por abandono.
//
// Reinicio del servidor: las partidas en juego se CANCELAN y se devuelven las apuestas
// (ver recoverOnStartup).

export const settings = {
  nextHandDelayMs: 2500, // pausa para que se vea cómo terminó la mano antes del próximo reparto
  finishedTtlMs: 5 * 60 * 1000, // cuánto queda en memoria una partida terminada (reconexiones tardías)
  turnTimeoutMs: env.turnTimeoutSeconds * 1000,
  reconnectGraceMs: env.reconnectGraceSeconds * 1000,
  // 2 vs 2: pausa máxima acumulada por desconexión de cada jugador (superada, abandona)
  maxDisconnectPauseMs: env.maxDisconnectPauseSeconds * 1000
};
const MAX_REMEMBERED_ACTIONS = 200;

/** Señas del 2 vs 2: lista cerrada (sin texto libre). No se valida que sean verdad, como en la mesa real. */
export const SIGNS = [
  'ANCHO_ESPADA', 'ANCHO_BASTO', 'SIETE_ESPADA', 'SIETE_ORO', 'UN_TRES', 'UN_DOS', 'ANCHO_FALSO', 'TENGO_ENVIDO', 'NO_TENGO_NADA'
];
export const SIGN_INTERVAL_MS = 2000;

/** @type {Map<string, object>} matchId -> runtime */
const runtimes = new Map();

// Quién quiere enterarse cuando termina una partida (torneos). matchService no importa a esos módulos
// para no armar un ciclo: ellos se registran acá.
const finishedListeners = [];

/** Registra un callback que recibe { matchId, roomId, tournamentId, round, winnerIds, loserIds }. */
export function onMatchFinished(listener) {
  finishedListeners.push(listener);
}

// ─── Ciclo de vida ────────────────────────────────────────

/** Arranca una partida ya persistida (Match en estado `playing`, apuestas ya bloqueadas). */
export function startMatch({ match, room }) {
  const players = [...match.players].sort((a, b) => a.seat - b.seat).map((p) => ({
    id: String(p.userId),
    username: p.username
  }));

  const rt = {
    matchId: String(match._id),
    roomId: String(room._id),
    roomCode: room.code,
    bet: match.config.bet || 0,
    isPrivate: Boolean(match.config.isPrivate),
    mode: match.config.mode || (players.length === 4 ? '2v2' : '1v1'),
    tournamentId: match.tournamentId ? String(match.tournamentId) : null,
    round: match.round ?? null,
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
    timers: new Set(), // timers sueltos (reparto, limpieza)
    turn: null, // { timer, deadline, playerIds } mientras corre
    turnRemainingMs: null, // lo que quedaba del turno cuando se pausó por una desconexión
    grace: new Map(), // userId -> { timer, deadline }
    finishing: false,
    finished: false,
    abandonedBy: null,
    abandoners: [],
    pauseUsedMs: new Map(), // 2 vs 2: tiempo de desconexión acumulado por jugador
    lastSignAt: new Map(), // 2 vs 2: para limitar a una seña cada 2 s
    chips: null
  };
  runtimes.set(rt.matchId, rt);

  // Hasta que cada jugador abra la mesa corre su gracia: si nunca entra, pierde por abandono
  for (const p of players) startGrace(rt, p.id, { announce: false });
  dealHand(rt);
  return rt;
}

function dealHand(rt) {
  if (rt.finished || rt.finishing) return;
  const { state, events } = dealNextHand(rt.state, shuffleDeck());
  rt.state = state;
  rt.handLog = {
    matchId: rt.matchId,
    handNumber: state.hand.number,
    manoId: state.players[state.hand.manoSeat].id,
    deck: state.hand.deck,
    dealt: state.hand.dealt,
    events: [],
    publicEvents: [],
    signs: [], // { from, to, sign, at }: las recibe solo el compañero
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

function clearAllTimers(rt) {
  for (const timer of rt.timers) clearTimeout(timer);
  rt.timers.clear();
  if (rt.turn) clearTimeout(rt.turn.timer);
  rt.turn = null;
  for (const { timer } of rt.grace.values()) clearTimeout(timer);
  rt.grace.clear();
}

// ─── Acciones ─────────────────────────────────────────────

function getActiveRuntime(matchId, userId) {
  const rt = runtimes.get(String(matchId));
  if (!rt || rt.finished || rt.finishing) throw new AppError('La partida no está activa', 404, 'MATCH_NOT_ACTIVE');
  if (!rt.players.some((p) => p.id === userId)) {
    throw new AppError('No sos parte de esta partida', 403, 'NOT_A_PLAYER');
  }
  return rt;
}

/**
 * Aplica una intención de jugada. `actionId` (uuid del cliente) evita procesar dos veces
 * la misma acción si el cliente reintenta. Lanza RuleError/AppError si no es válida.
 */
export async function handleAction(userId, { matchId, actionId, type, payload }) {
  const rt = getActiveRuntime(matchId, userId);
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

/**
 * 2 vs 2: seña a su compañero. Llega SOLO al compañero (los rivales nunca la reciben), únicamente con una mano
 * en curso y como máximo una cada 2 s. Queda en el MatchHandLog para auditoría.
 */
export function sendSign(userId, { matchId, sign }) {
  const rt = getActiveRuntime(matchId, userId);
  if (rt.mode !== '2v2') throw new AppError('Las señas son solo para 2 vs 2', 400, 'SIGNS_NOT_AVAILABLE');
  if (!SIGNS.includes(sign)) throw new AppError('Esa seña no existe', 400, 'INVALID_SIGN');
  if (rt.state.phase !== PHASES.PLAYING || !rt.handLog) throw new AppError('Las señas se hacen durante la mano', 409, 'NO_HAND');
  const now = Date.now();
  if (now - (rt.lastSignAt.get(userId) || 0) < SIGN_INTERVAL_MS) {
    throw new AppError('Esperá un momento antes de hacer otra seña', 429, 'SIGN_RATE_LIMITED');
  }
  rt.lastSignAt.set(userId, now);
  const me = rt.state.players.find((p) => p.id === userId);
  const partner = rt.state.players.find((p) => p.team === me.team && p.id !== userId);
  const entry = { from: userId, to: partner.id, sign, at: new Date(now).toISOString() };
  rt.handLog.signs.push(entry);
  const socketId = rt.sockets.get(partner.id);
  if (socketId) emitter.toSocket(socketId, 'game:sign', { matchId: rt.matchId, from: userId, sign, at: entry.at });
  return { sent: true };
}

/** El jugador abandona voluntariamente: pierde la partida (y la apuesta). */
export async function abandonMatch(userId, matchId) {
  const rt = getActiveRuntime(matchId, userId);
  await endByAbandon(rt, userId);
}

async function endByAbandon(rt, userId) {
  if (rt.finished || rt.finishing) return;
  const player = rt.state.players.find((p) => p.id === userId);
  const { state, events } = forfeitMatch(rt.state, player.team, 'abandon');
  rt.state = state;
  rt.abandonedBy = userId;
  // 2 vs 2: si en ese momento el compañero también estaba desconectado, abandonaron los dos
  const partner = rt.state.players.find((p) => p.team === player.team && p.id !== userId);
  rt.abandoners = partner && rt.grace.has(partner.id) && !rt.sockets.has(partner.id) ? [userId, partner.id] : [userId];
  rt.handLog?.events.push({ action: 'ABANDON', playerId: userId, payload: null, timestamp: new Date() });
  publish(rt, events);
  await afterTransition(rt);
}

async function onTurnTimeout(rt) {
  rt.turn = null;
  if (rt.finished || rt.finishing || rt.state.phase !== PHASES.PLAYING) return;
  const { state, events, playerId } = applyTimeout(rt.state);
  rt.state = state;
  rt.handLog.events.push({ action: 'TIMEOUT', playerId, payload: null, timestamp: new Date() });
  publish(rt, events);
  try {
    await afterTransition(rt);
  } catch (err) {
    console.error(`Error tras el vencimiento de turno en la partida ${rt.matchId}:`, err);
  }
}

async function afterTransition(rt) {
  if (rt.state.phase === PHASES.HAND_OVER) {
    await persistHand(rt);
    schedule(rt, () => dealHand(rt), settings.nextHandDelayMs);
  } else if (rt.state.phase === PHASES.FINISHED) {
    if (rt.finishing || rt.finished) return;
    rt.finishing = true;
    clearAllTimers(rt);
    await persistHand(rt);
    await finishMatch(rt);
  }
}

async function persistHand(rt) {
  const { state, handLog } = rt;
  if (!handLog || handLog.persisted) return;
  handLog.persisted = true;
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

/**
 * Resultado de cada jugador. En 2 vs 2, si su compañero abandonó y él no, queda "sin resultado"
 * (no suma derrota: no se lo castiga por el abandono del otro).
 */
function playerResult(rt, p) {
  if (p.team === rt.state.winnerTeam) return 'win';
  if (rt.abandoners.includes(p.id)) return 'abandon';
  if (rt.state.endReason === 'abandon' && rt.mode === '2v2') return 'no-result';
  return 'loss';
}

async function finishMatch(rt) {
  const { state } = rt;
  const results = Object.fromEntries(state.players.map((p) => [p.id, playerResult(rt, p)]));
  rt.results = results;
  const match = await Match.findById(rt.matchId).select('players').lean();
  await Match.updateOne({ _id: rt.matchId }, {
    status: 'finished',
    score: [...state.score],
    winnerTeam: state.winnerTeam,
    endReason: state.endReason,
    abandonedBy: rt.abandonedBy,
    abandoners: rt.abandoners,
    players: match.players.map((p) => ({ ...p, result: results[String(p.userId)] })),
    endedAt: new Date()
  });
  await Room.updateOne({ _id: rt.roomId }, { status: 'finished' });

  // Pago del pozo. Si falla, la partida queda con betsSettled=false y se reintenta al arrancar.
  try {
    rt.chips = await settleMatchBets(rt.matchId);
  } catch (err) {
    console.error(`No se pudo pagar la apuesta de la partida ${rt.matchId}:`, err);
  }

  // Las salas privadas quedan en el historial pero no suman estadísticas (que alimentan el ranking)
  // 1 vs 1 en `stats`; 2 vs 2 en `statsTwoVsTwo`. Quien queda "sin resultado" no suma nada.
  const prefix = rt.mode === '2v2' ? 'statsTwoVsTwo' : 'stats';
  const updates = state.players.filter((p) => results[p.id] !== 'no-result').map((p) => {
    const won = results[p.id] === 'win';
    const inc = { [`${prefix}.played`]: 1, [`${prefix}.${won ? 'won' : 'lost'}`]: 1 };
    if (results[p.id] === 'abandon') inc[`${prefix}.abandoned`] = 1;
    const net = rt.chips?.players.find((c) => c.userId === p.id)?.net ?? 0;
    if (net > 0) inc[`${prefix}.chipsWon`] = net;
    return { updateOne: { filter: { _id: p.id }, update: { $inc: inc } } };
  });
  if (!rt.isPrivate && updates.length) await User.bulkWrite(updates);

  rt.finished = true;
  rt.finishing = false;
  const summary = buildFinishedSummary(rt);
  emitter.toMatch(rt.matchId, 'game:finished', summary);
  schedule(rt, () => runtimes.delete(rt.matchId), settings.finishedTtlMs);

  const loserIds = state.players.filter((p) => p.team !== state.winnerTeam).map((p) => p.id);
  for (const listener of finishedListeners) {
    try {
      listener({ ...summary, roomId: rt.roomId, loserIds });
    } catch (err) {
      console.error(`Error en un aviso de fin de la partida ${rt.matchId}:`, err);
    }
  }
}

// ─── Timers ───────────────────────────────────────────────

function stopTurn(rt) {
  if (rt.turn) clearTimeout(rt.turn.timer);
  rt.turn = null;
}

function startTurn(rt, actors, ms) {
  const timer = setTimeout(() => onTurnTimeout(rt), ms);
  rt.turn = { timer, deadline: Date.now() + ms, playerIds: actors };
  rt.turnRemainingMs = null;
}

/**
 * Timer de turno. El reloj es de la DECISIÓN, no de la conexión:
 *  - Decisión nueva (carta jugada, canto, respuesta, reparto, vencimiento): arranca completo
 *    (o queda guardado entero si quien tiene que actuar está desconectado).
 *  - `keepClock` (alguien entró a la mesa, volvió del lobby o se reconectó; alguien se desconectó): NO lo reinicia.
 *    Si corre y sigue habiendo conectados, queda como está; si quien actúa se desconecta, se pausa guardando
 *    lo que quedaba; al volver, sigue desde ahí. Así salir y volver a la mesa no regala tiempo.
 */
function refreshTurnTimer(rt, { keepClock = false } = {}) {
  const actors = getActingPlayerIds(rt.state);
  if (rt.finished || rt.finishing || rt.state.phase !== PHASES.PLAYING || actors.length === 0) {
    stopTurn(rt);
    rt.turnRemainingMs = null;
    return;
  }
  const connected = actors.every((id) => rt.sockets.has(id));

  if (keepClock) {
    if (rt.turn) {
      if (connected) return; // sigue corriendo sin tocarlo
      rt.turnRemainingMs = Math.max(0, rt.turn.deadline - Date.now());
      stopTurn(rt);
      return;
    }
    if (connected) startTurn(rt, actors, rt.turnRemainingMs ?? settings.turnTimeoutMs);
    return;
  }

  stopTurn(rt);
  if (connected) startTurn(rt, actors, settings.turnTimeoutMs);
  else rt.turnRemainingMs = settings.turnTimeoutMs;
}

/** Cuánto puede seguir desconectado: la gracia, y en 2 vs 2 además lo que le queda de pausa acumulada. */
function graceDurationMs(rt, userId) {
  if (rt.mode !== '2v2') return settings.reconnectGraceMs;
  const left = settings.maxDisconnectPauseMs - (rt.pauseUsedMs.get(userId) || 0);
  return Math.max(0, Math.min(settings.reconnectGraceMs, left));
}

function startGrace(rt, userId, { announce = true } = {}) {
  if (rt.finished || rt.finishing || rt.grace.has(userId)) return;
  const ms = graceDurationMs(rt, userId);
  const timer = setTimeout(() => {
    rt.grace.delete(userId);
    endByAbandon(rt, userId).catch((err) => console.error(`Error al dar por abandonada la partida ${rt.matchId}:`, err));
  }, ms);
  rt.grace.set(userId, { timer, startedAt: Date.now(), deadline: Date.now() + ms });
  if (announce) {
    emitter.toMatch(rt.matchId, 'player:disconnected', { playerId: userId, graceSeconds: Math.round(ms / 1000) });
  }
}

function stopGrace(rt, userId) {
  const grace = rt.grace.get(userId);
  if (!grace) return false;
  clearTimeout(grace.timer);
  rt.grace.delete(userId);
  // Solo cuenta la pausa de una desconexión real (no la espera hasta que abre la mesa por primera vez)
  if (rt.everConnected.has(userId)) {
    rt.pauseUsedMs.set(userId, (rt.pauseUsedMs.get(userId) || 0) + (Date.now() - grace.startedAt));
  }
  return true;
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
    console.warn(`[SESSION_REPLACED] usuario ${userId} partida ${rt.matchId}: socket ${previous} -> ${socket.id}`);
    // Una sola conexión de juego por jugador: la nueva pestaña reemplaza a la anterior
    emitter.toSocket(previous, 'game:error', {
      code: 'SESSION_REPLACED',
      message: 'Abriste esta partida en otra pestaña o dispositivo'
    });
    emitter.removeSocketFromRoom(previous, emitter.rooms.match(rt.matchId));
  }
  rt.sockets.set(userId, socket.id);
  socket.join(emitter.rooms.match(rt.matchId));

  if (rt.finished) {
    socket.emit('game:state', buildStateFor(rt, userId));
    socket.emit('game:finished', buildFinishedSummary(rt));
    return;
  }

  const wasInGrace = stopGrace(rt, userId);
  if (wasInGrace && rt.everConnected.has(userId)) {
    emitter.toMatch(rt.matchId, 'player:reconnected', { playerId: userId });
  }
  rt.everConnected.add(userId);
  // Puede reanudarse un turno pausado (con lo que le quedaba): se reenvía el estado a todos
  publish(rt, [], { keepClock: true });
}

/** Se desconectó un socket: arranca la gracia de reconexión y se pausa su turno si le tocaba. */
export function detachSocket(userId, socketId) {
  for (const rt of runtimes.values()) {
    if (rt.sockets.get(userId) !== socketId) continue;
    rt.sockets.delete(userId);
    if (rt.finished || rt.finishing) continue;
    startGrace(rt, userId);
    publish(rt, [], { keepClock: true });
  }
}

// ─── Proyecciones ─────────────────────────────────────────

/** `keepClock`: es solo una conexión que cambió, no una decisión nueva (ver refreshTurnTimer). */
function publish(rt, events, { keepClock = false } = {}) {
  refreshTurnTimer(rt, { keepClock });
  // Los eventos del motor son públicos (cartas jugadas, cantos, tantos anunciados)
  for (const event of events) {
    emitter.toMatch(rt.matchId, 'game:event', event);
    rt.handLog?.publicEvents.push(event);
  }
  // El estado se envía proyectado a cada jugador por separado: nunca un broadcast del estado completo
  for (const p of rt.players) {
    const socketId = rt.sockets.get(p.id);
    if (socketId) emitter.toSocket(socketId, 'game:state', buildStateFor(rt, p.id));
  }
}

export function buildStateFor(rt, userId) {
  const now = Date.now();
  return {
    matchId: rt.matchId,
    roomId: rt.roomId,
    roomCode: rt.roomCode,
    bet: rt.bet,
    mode: rt.mode,
    tournament: rt.tournamentId ? { id: rt.tournamentId, round: rt.round } : null,
    usernames: Object.fromEntries(rt.players.map((p) => [p.id, p.username])),
    // Se manda el tiempo restante (no la hora) para no depender del reloj del cliente
    turn: rt.turn
      ? { playerIds: rt.turn.playerIds, remainingMs: Math.max(0, rt.turn.deadline - now), totalMs: settings.turnTimeoutMs }
      : null,
    disconnected: Object.fromEntries(
      [...rt.grace.entries()]
        .filter(([id]) => rt.everConnected.has(id))
        .map(([id, g]) => [id, { remainingMs: Math.max(0, g.deadline - now) }])
    ),
    ...projectStateFor(rt.state, userId),
    // 2 vs 2: señas que ESTE jugador recibió en la mano en curso (así se recuperan al reconectar)
    signs: rt.mode === '2v2' && rt.handLog
      ? rt.handLog.signs.filter((x) => x.to === userId).map(({ from, sign, at }) => ({ from, sign, at }))
      : []
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
    abandonedBy: rt.abandonedBy,
    abandoners: rt.abandoners,
    results: rt.results || null,
    mode: rt.mode,
    chips: rt.chips,
    tournamentId: rt.tournamentId,
    round: rt.round,
    rematchAllowed: !rt.tournamentId // las partidas de torneo no tienen revancha
  };
}

function buildFinishedSummaryFromDoc(match) {
  return {
    matchId: String(match._id),
    winnerTeam: match.winnerTeam,
    winnerIds: match.players.filter((p) => p.team === match.winnerTeam).map((p) => String(p.userId)),
    score: match.score,
    endReason: match.endReason,
    abandonedBy: match.abandonedBy ? String(match.abandonedBy) : null,
    abandoners: (match.abandoners || []).map(String),
    results: Object.fromEntries(match.players.map((p) => [String(p.userId), p.result || null])),
    mode: match.config?.mode || '1v1',
    chips: buildChipsSummary(match),
    tournamentId: match.tournamentId ? String(match.tournamentId) : null,
    round: match.round ?? null,
    rematchAllowed: false // la partida ya no está en memoria: la revancha caducó
  };
}

// ─── Arranque del servidor ────────────────────────────────

/**
 * Al reiniciar, las partidas en memoria se pierden. Política elegida: se CANCELAN las que quedaron
 * en juego y se devuelven sus apuestas; además se completa cualquier pago que haya quedado pendiente.
 */
export async function recoverOnStartup() {
  const interrupted = await Match.find({ status: 'playing' }).select('_id roomId').lean();
  if (interrupted.length > 0) {
    await Match.updateMany(
      { _id: { $in: interrupted.map((m) => m._id) } },
      { status: 'cancelled', endReason: 'cancelled', endedAt: new Date() }
    );
    await Room.updateMany({ _id: { $in: interrupted.map((m) => m.roomId) } }, { status: 'cancelled' });
    console.warn(`Se cancelaron ${interrupted.length} partida(s) interrumpidas por el reinicio`);
  }
  const settled = await settlePendingBets();
  if (settled > 0) console.warn(`Se liquidaron ${settled} apuesta(s) pendientes`);
  return { cancelled: interrupted.length, settled };
}

// ─── Consultas (revancha y tests) ─────────────────────────

export function getRuntime(matchId) {
  return runtimes.get(String(matchId));
}

export function clearRuntimes() {
  for (const rt of runtimes.values()) clearAllTimers(rt);
  runtimes.clear();
}
