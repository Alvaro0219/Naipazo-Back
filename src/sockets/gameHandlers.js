import { gameActionSchema, gameSignSchema, matchRefSchema, validateSocketPayload } from '../schemas/socket.schemas.js';
import * as matchService from '../services/matchService.js';
import * as rematchService from '../services/rematchService.js';
import { AppError } from '../utils/AppError.js';
import { createSocketLimiter, safeHandler } from './safeHandler.js';

// Cumple el rol de "controller" del tiempo real: valida el input y delega en matchService.
export function registerGameHandlers(socket) {
  const allow = createSocketLimiter({ max: 8, windowMs: 1000 });

  socket.on('game:action', safeHandler(socket, async (payload) => {
    if (!allow()) throw new AppError('Estás enviando acciones demasiado rápido', 429, 'RATE_LIMITED');
    const action = validateSocketPayload(gameActionSchema, payload);
    await matchService.handleAction(socket.user.id, action, { socketId: socket.id });
  }));

  // 2 vs 2: seña al compañero (el servidor la reenvía solo a él)
  socket.on('game:sign', safeHandler(socket, async (payload) => {
    matchService.sendSign(socket.user.id, validateSocketPayload(gameSignSchema, payload), { socketId: socket.id });
  }));

  // Abandonar la partida en curso: es una derrota (y se pierde la apuesta)
  socket.on('game:abandon', safeHandler(socket, async (payload) => {
    const { matchId } = validateSocketPayload(matchRefSchema, payload);
    await matchService.abandonMatch(socket.user.id, matchId, { socketId: socket.id });
  }));

  // Revancha: pedirla (o aceptarla si el rival ya la pidió) y rechazarla
  socket.on('game:rematch', safeHandler(socket, async (payload) => {
    const { matchId } = validateSocketPayload(matchRefSchema, payload);
    await rematchService.requestRematch(socket.user.id, matchId);
  }));

  socket.on('game:rematch:decline', safeHandler(socket, async (payload) => {
    const { matchId } = validateSocketPayload(matchRefSchema, payload);
    rematchService.declineRematch(socket.user.id, matchId);
  }));
}
