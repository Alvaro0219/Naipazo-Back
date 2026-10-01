import rateLimit from 'express-rate-limit';

function buildLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
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

// Chequeo de disponibilidad en vivo del formulario de registro (se dispara mientras se tipea)
export const availabilityLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Demasiadas consultas. Esperá un momento.'
});
