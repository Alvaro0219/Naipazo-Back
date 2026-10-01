import { RuleError } from '../game/truco/index.js';
import { AppError } from '../utils/AppError.js';

/**
 * Envuelve un handler de Socket.IO: cualquier error se le informa SOLO a ese socket como
 * `game:error { code, message }`. Igual que el error handler HTTP, nunca expone mensajes internos.
 */
export function safeHandler(socket, handler) {
  return async (payload) => {
    try {
      await handler(payload);
    } catch (err) {
      if (err instanceof AppError || err instanceof RuleError) {
        socket.emit('game:error', { code: err.code, message: err.message, actionId: payload?.actionId });
        return;
      }
      console.error('Socket handler error:', err);
      socket.emit('game:error', { code: 'INTERNAL_ERROR', message: 'Error interno del servidor', actionId: payload?.actionId });
    }
  };
}

/** Límite simple por conexión: como máximo `max` eventos por ventana de `windowMs`. */
export function createSocketLimiter({ max, windowMs }) {
  let windowStart = 0;
  let count = 0;
  return () => {
    const now = Date.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    return count <= max;
  };
}
