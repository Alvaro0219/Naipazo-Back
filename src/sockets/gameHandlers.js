import { gameActionSchema, matchRefSchema, validateSocketPayload } from '../schemas/socket.schemas.js';
import * as matchService from '../services/matchService.js';
import { AppError } from '../utils/AppError.js';
import { createSocketLimiter, safeHandler } from './safeHandler.js';

// Cumple el rol de "controller" del tiempo real: valida el input y delega en matchService.
export function registerGameHandlers(socket) {
  const allow = createSocketLimiter({ max: 8, windowMs: 1000 });

  socket.on('game:action', safeHandler(socket, async (payload) => {
    if (!allow()) throw new AppError('Estás enviando acciones demasiado rápido', 429, 'RATE_LIMITED');
    const action = validateSocketPayload(gameActionSchema, payload);
    await matchService.handleAction(socket.user.id, action);
  }));

  // Abandonar la partida en curso: es una derrota (y se pierde la apuesta)
  socket.on('game:abandon', safeHandler(socket, async (payload) => {
    const { matchId } = validateSocketPayload(matchRefSchema, payload);
    await matchService.abandonMatch(socket.user.id, matchId);
  }));
}
