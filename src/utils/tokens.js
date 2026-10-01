import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export function issueTokens(user) {
  const accessToken = jwt.sign({
    sub: user._id.toString(),
    role: user.role,
    username: user.username
  }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });

  // `ver` permite invalidar todos los refresh tokens del usuario (logout, bloqueo)
  const refreshToken = jwt.sign({
    sub: user._id.toString(),
    ver: user.tokenVersion || 0
  }, env.refreshSecret, { expiresIn: env.refreshExpiresIn });

  return { accessToken, refreshToken };
}

/** Verifica un access token. Lanza si es inválido o expiró. Lo usan HTTP y Socket.IO. */
export function verifyAccessToken(token) {
  const payload = jwt.verify(token, env.jwtSecret);
  return { id: payload.sub, role: payload.role, username: payload.username };
}

export function verifyRefreshToken(token) {
  const payload = jwt.verify(token, env.refreshSecret);
  return { id: payload.sub, ver: payload.ver || 0 };
}
