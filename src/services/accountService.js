import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { AuthToken } from '../models/AuthToken.js';
import { User } from '../models/User.js';
import { AppError } from '../utils/AppError.js';
import { sendPasswordResetEmail, sendVerificationEmail } from './emailService.js';

// Verificación de email y recuperación de contraseña con tokens de un solo uso (P4).
export const settings = {
  verifyTtlMs: 24 * 60 * 60 * 1000,
  resetTtlMs: 60 * 60 * 1000,
  maxVerificationEmailsPerHour: 3
};

const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const INVALID_LINK = () => new AppError('El enlace no es válido o ya venció. Pedí uno nuevo.', 400, 'INVALID_TOKEN');

/** Crea un token nuevo (anula los anteriores sin usar del mismo tipo) y devuelve el valor en claro. */
async function issueToken(userId, type, ttlMs) {
  await AuthToken.updateMany({ userId, type, usedAt: null }, { usedAt: new Date() });
  const token = randomBytes(32).toString('hex');
  await AuthToken.create({ userId, type, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs) });
  return token;
}

/** Marca el token como usado de forma atómica: dos usos simultáneos no pueden pasar los dos. */
async function consumeToken(token, type) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw INVALID_LINK();
  const doc = await AuthToken.findOneAndUpdate(
    { tokenHash: hashToken(token), type, usedAt: null, expiresAt: { $gt: new Date() } },
    { usedAt: new Date() },
    { new: true }
  );
  if (!doc) throw INVALID_LINK();
  return doc;
}

const logSendError = (what) => (err) => console.error(`No se pudo enviar el email de ${what}:`, err.message);

/** Al registrarse: envía el enlace de verificación. Un fallo del proveedor no impide el registro. */
export async function startEmailVerification(user) {
  const token = await issueToken(user._id, 'verify-email', settings.verifyTtlMs);
  await sendVerificationEmail(user, token).catch(logSendError('verificación'));
}

export async function resendVerification(userId) {
  const user = await User.findById(userId);
  if (!user || !user.isActive) throw new AppError('Usuario no encontrado', 404, 'NOT_FOUND');
  if (user.emailVerified) return { alreadyVerified: true };

  const since = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await AuthToken.countDocuments({ userId: user._id, type: 'verify-email', createdAt: { $gte: since } });
  if (recent >= settings.maxVerificationEmailsPerHour) {
    throw new AppError('Ya te mandamos varios emails. Esperá un rato antes de pedir otro.', 429, 'TOO_MANY_EMAILS');
  }
  await startEmailVerification(user);
  return { sent: true };
}

export async function verifyEmail(token) {
  const doc = await consumeToken(token, 'verify-email');
  const user = await User.findOneAndUpdate({ _id: doc.userId }, { emailVerified: true }, { new: true });
  if (!user) throw INVALID_LINK();
  return { verified: true };
}

/**
 * Responde siempre lo mismo, exista o no la cuenta, para no revelar qué emails están registrados.
 * El token y el email se generan sin esperar, así el tiempo de respuesta tampoco lo delata.
 */
export async function forgotPassword(email) {
  const user = await User.findOne({ email: email.trim().toLowerCase(), isActive: true });
  if (user) {
    issueToken(user._id, 'reset-password', settings.resetTtlMs)
      .then((token) => sendPasswordResetEmail(user, token))
      .catch(logSendError('recuperación'));
  }
  return { sent: true };
}

/** Cambia la contraseña y cierra todas las sesiones (sube tokenVersion). */
export async function resetPassword(token, password) {
  const doc = await consumeToken(token, 'reset-password');
  const passwordHash = await bcrypt.hash(password, 10);
  // Quien pudo leer el email también demostró que es suyo
  const user = await User.findOneAndUpdate(
    { _id: doc.userId, isActive: true },
    { passwordHash, emailVerified: true, $inc: { tokenVersion: 1 } },
    { new: true }
  );
  if (!user) throw INVALID_LINK();
  return { reset: true };
}
