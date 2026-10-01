import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { AppError } from '../utils/AppError.js';
import { issueTokens } from '../utils/tokens.js';
import { toPublicUser } from './authService.js';

/**
 * Cambia la contraseña verificando la actual. Cierra las demás sesiones (incrementa tokenVersion)
 * y devuelve tokens nuevos para la sesión actual.
 * Ojo: la contraseña incorrecta responde 400 y no 401, para que el front no lo confunda con una
 * sesión vencida e intente refrescar.
 */
export async function changePassword(userId, { currentPassword, newPassword }) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user || !user.isActive) throw new AppError('Usuario no encontrado', 404, 'NOT_FOUND');
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw new AppError('La contraseña actual no es correcta', 400, 'WRONG_PASSWORD');
  }
  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    throw new AppError('La contraseña nueva tiene que ser distinta de la actual', 400, 'SAME_PASSWORD');
  }

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();
  return { user: toPublicUser(user), ...issueTokens(user) };
}
