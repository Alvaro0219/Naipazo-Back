import { fail } from '../utils/response.js';
import { verifyAccessToken } from '../utils/tokens.js';

export function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return fail(res, 'Tenés que iniciar sesión', 401, 'UNAUTHORIZED');
  }
  try {
    req.user = verifyAccessToken(token);
    return next();
  } catch {
    return fail(res, 'La sesión expiró o no es válida', 401, 'UNAUTHORIZED');
  }
}

export function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return fail(res, 'No tenés permisos para esta acción', 403, 'FORBIDDEN');
    }
    return next();
  };
}
