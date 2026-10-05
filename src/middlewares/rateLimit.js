import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

// RATE_LIMITS_RELAXED (solo pruebas e2e, nunca en producción) multiplica los topes para poder repetir corridas
const relax = (max) => (env.rateLimitsRelaxed ? max * 100 : max);

function buildLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max: relax(max),
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: { message, code: 'RATE_LIMITED' } }
  });
}

export const globalApiLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: 'Demasiadas solicitudes. Probá de nuevo en unos minutos.'
});

export const authLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Demasiados intentos. Esperá unos minutos antes de volver a intentar.'
});

// P4: enlaces por email (verificar, reenviar, olvidé mi contraseña, cambiarla). Estricto: cada uno manda emails
export const emailLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Demasiados intentos. Esperá unos minutos antes de volver a intentar.'
});

// P5: registros por IP y por día. Moderado a propósito: las operadoras móviles comparten IP entre muchos usuarios
export const registerLimiter = buildLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  max: env.registerMaxPerIpPerDay,
  message: 'Se crearon demasiadas cuentas desde esta conexión hoy. Probá de nuevo mañana.'
});

// P6: buscar o usar códigos de sala. Por IP (antes de autenticar) y por usuario, para impedir adivinarlos
export const roomCodeIpLimiter = buildLimiter({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: 'Demasiados intentos con códigos de sala. Esperá unos minutos.'
});

export const roomCodeUserLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: relax(15),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user.id}`,
  message: { success: false, error: { message: 'Demasiados intentos con códigos de sala. Esperá unos minutos.', code: 'RATE_LIMITED' } }
});

// Crear / unirse a salas
export const roomLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Demasiadas operaciones con salas. Esperá un momento.'
});

// Chequeo de disponibilidad en vivo del formulario de registro (se dispara mientras se tipea)
export const availabilityLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Demasiadas consultas. Esperá un momento.'
});
