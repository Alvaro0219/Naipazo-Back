import mongoose from 'mongoose';

/**
 * Ejecuta `fn(session)` dentro de una transacción. Si ya se recibe una sesión
 * (transacción abierta por el llamador), se reutiliza en vez de abrir otra.
 * `withTransaction` reintenta `fn` ante errores transitorios (ej. write conflicts),
 * por eso `fn` tiene que ser idempotente respecto de su propio estado.
 */
export async function runInTransaction(fn, existingSession = null) {
  if (existingSession) return fn(existingSession);

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
