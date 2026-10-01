import bcrypt from 'bcryptjs';
import Joi from 'joi';
import { User } from '../models/User.js';
import { AppError } from '../utils/AppError.js';
import { issueTokens, verifyRefreshToken } from '../utils/tokens.js';
import { isReservedUsername, isValidUsernameFormat, normalizeUsername } from '../utils/username.js';
import { claimDailyGrantIfDue } from './walletService.js';

// Hash fijo para comparar cuando el usuario no existe: iguala los tiempos de respuesta
// y evita revelar por timing si un email/usuario está registrado.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

const INVALID_CREDENTIALS = () => new AppError('Credenciales inválidas', 401, 'INVALID_CREDENTIALS');
const INVALID_SESSION = () => new AppError('La sesión expiró. Volvé a iniciar sesión.', 401, 'INVALID_REFRESH');
const emailTaken = () => new AppError('Ese email ya está registrado', 409, 'EMAIL_TAKEN');
const usernameTaken = () => new AppError('Ese nombre de usuario ya está en uso', 409, 'USERNAME_TAKEN');

const emailFormat = Joi.string().email({ tlds: { allow: false } }).max(254);

export function toPublicUser(user) {
  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    role: user.role,
    balance: user.balance,
    emailVerified: user.emailVerified,
    stats: {
      played: user.stats?.played ?? 0,
      won: user.stats?.won ?? 0,
      lost: user.stats?.lost ?? 0,
      abandoned: user.stats?.abandoned ?? 0,
      chipsWon: user.stats?.chipsWon ?? 0
    },
    createdAt: user.createdAt
  };
}

/** Arma la respuesta de sesión: dispara el crédito diario y devuelve el usuario con saldo actualizado. */
async function buildSession(userDoc) {
  const dailyGrant = await claimDailyGrantIfDue(userDoc._id);
  const user = dailyGrant.granted ? await User.findById(userDoc._id) : userDoc;
  return { user: toPublicUser(user), ...issueTokens(user), dailyGrant };
}

export async function register({ username, email, password }) {
  const usernameLower = normalizeUsername(username);

  // Validación previa para dar el error correcto; el índice único es el respaldo ante carreras
  const [emailExists, usernameExists] = await Promise.all([
    User.exists({ email }),
    User.exists({ usernameLower })
  ]);
  if (emailExists) throw emailTaken();
  if (usernameExists) throw usernameTaken();

  const passwordHash = await bcrypt.hash(password, 10);
  let user;
  try {
    user = await User.create({
      username,
      email,
      passwordHash,
      acceptedTermsAt: new Date()
    });
  } catch (err) {
    if (err?.code === 11000) {
      if (err.keyPattern?.email) throw emailTaken();
      if (err.keyPattern?.usernameLower) throw usernameTaken();
    }
    throw err;
  }

  return buildSession(user);
}

export async function login({ identifier, password }) {
  const value = identifier.trim();
  const filter = value.includes('@')
    ? { email: value.toLowerCase() }
    : { usernameLower: value.toLowerCase() };

  const user = await User.findOne(filter).select('+passwordHash');
  const valid = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH);
  if (!user || !valid) throw INVALID_CREDENTIALS();
  if (!user.isActive) throw new AppError('Tu cuenta está suspendida', 403, 'ACCOUNT_DISABLED');

  return buildSession(user);
}

export async function refresh(refreshToken) {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw INVALID_SESSION();
  }
  const user = await User.findById(payload.id);
  if (!user || !user.isActive || (user.tokenVersion || 0) !== payload.ver) throw INVALID_SESSION();

  return buildSession(user);
}

/** Invalida todos los refresh tokens del usuario. Si el token no es válido, no hace nada. */
export async function logout(refreshToken) {
  if (!refreshToken) return;
  try {
    const payload = verifyRefreshToken(refreshToken);
    await User.updateOne({ _id: payload.id, tokenVersion: payload.ver }, { $inc: { tokenVersion: 1 } });
  } catch {
    // token vencido o inválido: la sesión del cliente se cierra igual
  }
}

export async function getMe(userId) {
  const user = await User.findById(userId);
  if (!user || !user.isActive) throw new AppError('Usuario no encontrado', 404, 'NOT_FOUND');
  return toPublicUser(user);
}

/** Disponibilidad en vivo para el formulario de registro. */
export async function checkAvailability({ username, email }) {
  const result = {};

  if (username !== undefined) {
    if (!isValidUsernameFormat(username)) {
      result.username = { available: false, reason: 'INVALID' };
    } else if (isReservedUsername(username)) {
      result.username = { available: false, reason: 'RESERVED' };
    } else {
      const taken = await User.exists({ usernameLower: normalizeUsername(username) });
      result.username = taken ? { available: false, reason: 'TAKEN' } : { available: true };
    }
  }

  if (email !== undefined) {
    const normalized = email.trim().toLowerCase();
    if (emailFormat.validate(normalized).error) {
      result.email = { available: false, reason: 'INVALID' };
    } else {
      const taken = await User.exists({ email: normalized });
      result.email = taken ? { available: false, reason: 'TAKEN' } : { available: true };
    }
  }

  return result;
}
