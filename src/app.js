import http from 'http';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { corsOptions } from './config/cors.js';
import { connectDb } from './config/db.js';
import { env } from './config/env.js';
import { globalApiLimiter } from './middlewares/rateLimit.js';
import apiRoutes from './routes/index.js';
import { AppError } from './utils/AppError.js';
import { fail } from './utils/response.js';

const app = express();

// Railway (y cualquier proxy) agrega X-Forwarded-For: sin esto el rate limit
// trataría a todos los usuarios como una sola IP.
app.set('trust proxy', 1);

// 1. CORS
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
// 2. Logging
app.use(morgan('dev'));
// 3. Headers de seguridad
app.use(helmet());
// 4. Body JSON
app.use(express.json({ limit: '1mb' }));
// 5. Rate limit global
app.use('/api', globalApiLimiter);
// 6. Healthcheck
app.get('/health', (req, res) => res.json({ ok: true }));
// 7. Rutas
app.use('/api', apiRoutes);
app.use('/api', (req, res) => fail(res, 'Recurso no encontrado', 404, 'NOT_FOUND'));

// 8. Error handler global
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({ success: false, error: { message: err.message, code: err.code } });
  }

  console.error('Unhandled error:', err);

  if (err.type === 'entity.parse.failed') { // JSON mal formado
    return res.status(400).json({ success: false, error: { message: 'JSON inválido', code: 'INVALID_JSON' } });
  }
  if (err.name === 'ValidationError') { // Joi o Mongoose
    const message = err.isJoi ? err.message : 'Datos inválidos';
    return res.status(400).json({ success: false, error: { message, code: 'VALIDATION_ERROR' } });
  }
  if (err.code === 11000) { // duplicado en Mongo
    return res.status(409).json({ success: false, error: { message: 'El recurso ya existe', code: 'CONFLICT' } });
  }
  if (err.name === 'CastError') { // ObjectId inválido
    return res.status(400).json({ success: false, error: { message: 'Identificador inválido', code: 'INVALID_ID' } });
  }

  // Nunca exponer err.message crudo para errores no controlados
  return res.status(500).json({ success: false, error: { message: 'Error interno del servidor', code: 'INTERNAL_ERROR' } });
});

export async function startServer() {
  try {
    await connectDb();
  } catch (err) {
    console.error('No se pudo conectar a MongoDB:', err.message);
    process.exit(1);
  }

  // Servidor HTTP explícito: Socket.IO (hito M4) se monta sobre esta misma instancia
  const server = http.createServer(app);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`El puerto ${env.port} ya está en uso: cerrá el otro proceso o cambiá PORT en .env`);
    } else {
      console.error('Error del servidor HTTP:', err);
    }
    process.exit(1);
  });
  server.listen(env.port, () => {
    console.log(`Truco API escuchando en http://localhost:${env.port} (${env.nodeEnv})`);
  });
  return server;
}

startServer();

export default app;
