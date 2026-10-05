import { Match } from '../models/Match.js';
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

/**
 * P5: pares de cuentas con muchas partidas privadas con apuesta entre sí. Marca los pares donde las fichas
 * van siempre en la misma dirección (posible traspaso perdiendo a propósito). Solo informa: no bloquea nada.
 */
export async function chipFlows({ days = 30, minMatches = 3 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const matches = await Match.find({
    status: 'finished', 'config.isPrivate': true, 'config.bet': { $gt: 0 }, endedAt: { $gte: since }
  }).select('players winnerTeam config.bet endedAt').sort({ endedAt: -1 }).limit(5000).lean();

  const pairs = new Map();
  for (const m of matches) {
    if (m.players.length !== 2 || m.winnerTeam === null) continue;
    const [a, b] = [...m.players].sort((x, y) => String(x.userId).localeCompare(String(y.userId)));
    const key = `${a.userId}:${b.userId}`;
    const pair = pairs.get(key) || {
      a: { id: String(a.userId), username: a.username, wins: 0 },
      b: { id: String(b.userId), username: b.username, wins: 0 },
      matches: 0, netToA: 0, lastAt: m.endedAt
    };
    const aWon = a.team === m.winnerTeam;
    pair.matches += 1;
    (aWon ? pair.a : pair.b).wins += 1;
    pair.netToA += aWon ? m.config.bet : -m.config.bet;
    pairs.set(key, pair);
  }

  return [...pairs.values()]
    .filter((p) => p.matches >= minMatches)
    .map((p) => {
      const receiver = p.netToA >= 0 ? p.a : p.b;
      const giver = receiver === p.a ? p.b : p.a;
      return {
        receiver: { id: receiver.id, username: receiver.username },
        giver: { id: giver.id, username: giver.username },
        matches: p.matches,
        receiverWins: receiver.wins,
        giverWins: giver.wins,
        chips: Math.abs(p.netToA),
        oneDirection: giver.wins === 0,
        lastAt: p.lastAt
      };
    })
    .sort((x, y) => Number(y.oneDirection) - Number(x.oneDirection) || y.chips - x.chips)
    .slice(0, 100);
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
