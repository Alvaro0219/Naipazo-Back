import { env } from '../config/env.js';
import * as emitter from '../sockets/emitter.js';
import { AppError } from '../utils/AppError.js';
import * as matchService from './matchService.js';
import { createRematchRoom } from './roomService.js';

// Revancha al terminar una partida normal (no de torneo). Uno la pide y los demás la aceptan pidiéndola
// también (en 2 vs 2 tienen que aceptar los 4); si nadie acepta en REMATCH_WINDOW_SECONDS, o alguno la rechaza, caduca. Al aceptar se crea una
// sala nueva con la misma configuración y se bloquean de nuevo las apuestas (roomService.createRematchRoom).
// El estado vive con la partida terminada en memoria (matchService la guarda unos minutos).
//
// Eventos `game:rematch` a la mesa: { matchId, state, by?, roomId?, message? }
//   requested (by = quien la pidió o aceptó, accepted = todos los que ya aceptaron) | declined (by) | expired |
//   started (roomId) | failed (message)

export const settings = {
  windowMs: env.rematchWindowSeconds * 1000
};

/** matchId -> { accepted: Set<userId>, timer, starting } */
const pending = new Map();

function finishedRuntime(matchId, userId) {
  const rt = matchService.getRuntime(matchId);
  if (!rt || !rt.finished) throw new AppError('La revancha ya no está disponible', 409, 'REMATCH_UNAVAILABLE');
  if (!rt.players.some((p) => p.id === userId)) throw new AppError('No sos parte de esta partida', 403, 'NOT_A_PLAYER');
  if (rt.tournamentId) throw new AppError('Las partidas de torneo no tienen revancha', 400, 'REMATCH_NOT_ALLOWED');
  if (rt.rematchClosed) throw new AppError('La revancha ya no está disponible', 409, 'REMATCH_UNAVAILABLE');
  return rt;
}

function close(rt) {
  const entry = pending.get(rt.matchId);
  if (entry) clearTimeout(entry.timer);
  pending.delete(rt.matchId);
  rt.rematchClosed = true;
}

function announce(rt, data) {
  // Se guarda el último aviso para reenviarlo a quien se reconecte (rematchStatusFor)
  rt.rematchLast = { matchId: rt.matchId, ...data };
  emitter.toMatch(rt.matchId, 'game:rematch', rt.rematchLast);
}

/** Al volver a entrar a una partida terminada: el último estado de la revancha (o null si nadie la pidió). */
export function rematchStatusFor(matchId) {
  const rt = matchService.getRuntime(matchId);
  if (!rt?.finished || !rt.rematchLast) return null;
  const entry = pending.get(rt.matchId);
  return entry ? { ...rt.rematchLast, expiresInMs: Math.max(0, entry.expiresAt - Date.now()) } : rt.rematchLast;
}

/** Pedir la revancha, o aceptarla si el rival ya la había pedido. */
export async function requestRematch(userId, matchId) {
  const rt = finishedRuntime(matchId, userId);
  const entry = pending.get(rt.matchId);

  if (!entry) {
    const timer = setTimeout(() => {
      if (pending.get(rt.matchId)?.timer !== timer) return;
      close(rt);
      announce(rt, { state: 'expired' });
    }, settings.windowMs);
    pending.set(rt.matchId, { accepted: new Set([userId]), timer, starting: false, expiresAt: Date.now() + settings.windowMs });
    announce(rt, { state: 'requested', by: userId, accepted: [userId], expiresInMs: settings.windowMs });
    return { state: 'requested' };
  }
  if (entry.accepted.has(userId) || entry.starting) return { state: 'requested' };

  entry.accepted.add(userId);
  if (entry.accepted.size < rt.players.length) {
    // 2 vs 2: faltan otros por aceptar
    announce(rt, { state: 'requested', by: userId, accepted: [...entry.accepted], expiresInMs: Math.max(0, entry.expiresAt - Date.now()) });
    return { state: 'requested' };
  }

  // Aceptaron todos: arranca la revancha
  entry.starting = true;
  try {
    const room = await createRematchRoom(rt.roomId, rt.players);
    close(rt);
    announce(rt, { state: 'started', roomId: room.id });
    return { state: 'started', roomId: room.id };
  } catch (err) {
    close(rt);
    const message = err instanceof AppError ? err.message : 'No se pudo armar la revancha';
    announce(rt, { state: 'failed', message });
    if (!(err instanceof AppError)) throw err;
    return { state: 'failed', message };
  }
}

/** Rechazar la revancha (o retirarla): caduca para los dos. */
export function declineRematch(userId, matchId) {
  const rt = matchService.getRuntime(matchId);
  if (!rt || !rt.finished || rt.rematchClosed || !rt.players.some((p) => p.id === userId)) return;
  if (pending.get(rt.matchId)?.starting) return;
  close(rt);
  announce(rt, { state: 'declined', by: userId });
}

// ─── Solo tests ───────────────────────────────────────────

export function clearPending() {
  for (const { timer } of pending.values()) clearTimeout(timer);
  pending.clear();
}
