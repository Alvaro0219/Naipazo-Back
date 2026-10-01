import { User } from '../models/User.js';
import { AppError } from '../utils/AppError.js';
import { adminAdjust } from './walletService.js';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function toAdminUser(u) {
  return {
    id: String(u._id),
    username: u.username,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    balance: u.balance,
    stats: u.stats,
    createdAt: u.createdAt
  };
}

export async function listUsers({ search }, { skip, limit }) {
  const filter = {};
  if (search) {
    const rx = new RegExp(escapeRegex(search.trim().toLowerCase()));
    filter.$or = [{ usernameLower: rx }, { email: rx }];
  }
  const [items, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    User.countDocuments(filter)
  ]);
  return { items: items.map(toAdminUser), total };
}

/**
 * Bloquea o desbloquea una cuenta. Al bloquear se invalidan sus refresh tokens: no puede volver a
 * entrar ni renovar la sesión (el access token vigente vence solo, en JWT_EXPIRES_IN como máximo).
 */
export async function setUserActive(adminId, userId, isActive) {
  if (adminId === userId) throw new AppError('No podés bloquear tu propia cuenta', 400, 'CANNOT_BLOCK_SELF');
  const update = { isActive };
  if (!isActive) update.$inc = { tokenVersion: 1 };
  const user = await User.findByIdAndUpdate(userId, update, { new: true }).lean();
  if (!user) throw new AppError('Usuario no encontrado', 404, 'NOT_FOUND');
  return toAdminUser(user);
}

/** Ajuste manual de fichas: siempre deja un asiento ADMIN_ADJUST con el motivo. */
export async function adjustChips(adminId, userId, { amount, reason, operationId }) {
  const result = await adminAdjust({ userId, amount, adminId, reason, operationId });
  const user = await User.findById(userId).lean();
  return { user: toAdminUser(user), entry: { id: String(result.entry._id), amount: result.entry.amount, duplicated: result.duplicated } };
}
