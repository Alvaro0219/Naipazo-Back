import { env } from './env.js';

// Misma política para Express y (más adelante) Socket.IO.
// Sin CORS_ORIGINS en desarrollo se permite cualquier origen; en producción, solo la lista.
export function isOriginAllowed(origin) {
  if (!origin) return true; // curl, healthchecks, apps nativas
  if (env.corsOrigins.length === 0) return env.nodeEnv !== 'production';
  return env.corsOrigins.includes(origin);
}

export const corsOptions = {
  origin(origin, callback) {
    callback(null, isOriginAllowed(origin));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600
};
