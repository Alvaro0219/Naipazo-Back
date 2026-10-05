import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { LedgerEntry } from '../models/LedgerEntry.js';
import { User } from '../models/User.js';
import { AppError } from '../utils/AppError.js';
import { dateKeyInTz, nextDayStartInTz } from '../utils/dates.js';
import { runInTransaction } from '../utils/transaction.js';

// ÚNICO punto del código que modifica User.balance. Cada cambio de saldo:
//   1. corre dentro de una transacción,
//   2. usa un $inc atómico condicionado (saldo suficiente, crédito diario pendiente, etc.),
//   3. inserta el LedgerEntry con su idempotencyKey en la misma transacción,
//   4. si la idempotencyKey ya existía, devuelve el asiento previo sin duplicar nada.

function assertPositiveInt(amount) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new AppError('El monto debe ser un entero positivo', 400, 'INVALID_AMOUNT');
  }
}

function isDuplicateKeyError(err) {
  return err?.code === 11000 && Boolean(err?.keyPattern?.idempotencyKey ?? /idempotencyKey/.test(err?.message));
}

/**
 * Aplica un movimiento dentro de `session`. Devuelve:
 *  - { entry, duplicated: true } si la idempotencyKey ya existía (sin efectos),
 *  - { entry, duplicated: false } si se aplicó,
 *  - null si el filtro condicionado no matcheó (saldo insuficiente, ya acreditado, etc.).
 */
async function applyMovement(params, session) {
  const {
    userId, type, amount, idempotencyKey,
    refType = null, refId = null, note = null,
    extraFilter = {}, extraSet = null
  } = params;

  const existing = await LedgerEntry.findOne({ idempotencyKey }).session(session).lean();
  if (existing) return { entry: existing, duplicated: true };

  if (!Number.isInteger(amount) || amount === 0) {
    throw new AppError('Monto inválido', 400, 'INVALID_AMOUNT');
  }

  const filter = { _id: userId, ...extraFilter };
  if (amount < 0) filter.balance = { $gte: -amount };

  const update = { $inc: { balance: amount } };
  if (extraSet) update.$set = extraSet;

  const user = await User.findOneAndUpdate(filter, update, {
    new: true,
    session,
    projection: { balance: 1 }
  });
  if (!user) return null;

  const [entry] = await LedgerEntry.create([{
    userId, type, amount, balanceAfter: user.balance, refType, refId, idempotencyKey, note
  }], { session });

  return { entry: entry.toObject(), duplicated: false };
}

/**
 * Corre `run(session)` en la transacción del llamador (si pasa `session`) o en una propia.
 * Respaldo ante carreras: si otro proceso insertó la misma idempotencyKey en paralelo,
 * se devuelve ese asiento en vez de fallar.
 */
async function execute(run, idempotencyKey, session = null) {
  if (session) return run(session);
  try {
    return await runInTransaction(run);
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const existing = await LedgerEntry.findOne({ idempotencyKey }).lean();
      if (existing) return { entry: existing, duplicated: true };
    }
    throw err;
  }
}

/** Movimiento que tiene que aplicarse sí o sí: si no matchea, explica por qué. */
function strictMovement(params) {
  return async (session) => {
    const result = await applyMovement(params, session);
    if (result) return result;
    const exists = await User.exists({ _id: params.userId }).session(session);
    if (!exists) throw new AppError('Usuario no encontrado', 404, 'NOT_FOUND');
    throw new AppError('No hay fichas suficientes', 400, 'INSUFFICIENT_BALANCE');
  };
}

// ─── Crédito diario ───────────────────────────────────────

export function getDailyGrantInfo(now = new Date()) {
  return {
    today: dateKeyInTz(now, env.appTimezone),
    nextGrantAt: nextDayStartInTz(now, env.appTimezone)
  };
}

/**
 * Acredita DAILY_GRANT_AMOUNT si el usuario todavía no lo recibió hoy (zona APP_TIMEZONE).
 * Se dispara de forma perezosa (login, refresh, GET /wallet, conexión del socket).
 * Es seguro llamarla en paralelo: el $inc está condicionado a lastDailyGrantDate < hoy
 * y la idempotencyKey `daily:{userId}:{fecha}` es única. No se acumulan días sin entrar.
 */
export async function claimDailyGrantIfDue(userId, now = new Date()) {
  const { today, nextGrantAt } = getDailyGrantInfo(now);
  const amount = env.dailyGrantAmount;
  if (amount <= 0) return { granted: false, amount: 0, nextGrantAt };

  // P4: con la verificación obligatoria, solo las cuentas con email verificado reciben fichas
  if (env.requireEmailVerification) {
    const user = await User.findById(userId).select('emailVerified').lean();
    if (!user?.emailVerified) return { granted: false, amount, nextGrantAt, requiresVerification: true };
  }

  const idempotencyKey = `daily:${userId}:${today}`;
  const result = await execute((session) => applyMovement({
    userId,
    type: 'DAILY_GRANT',
    amount,
    idempotencyKey,
    extraFilter: {
      isActive: true,
      $or: [{ lastDailyGrantDate: null }, { lastDailyGrantDate: { $lt: today } }]
    },
    extraSet: { lastDailyGrantDate: today }
  }, session), idempotencyKey);

  return { granted: Boolean(result && !result.duplicated), amount, nextGrantAt };
}

// ─── Apuestas ─────────────────────────────────────────────
// Aceptan { session } para que roomService bloquee las apuestas de ambos jugadores
// en una sola transacción (si falla uno, no se bloquea nada).

export async function lockBet(matchId, userId, amount, { session = null } = {}) {
  assertPositiveInt(amount);
  const idempotencyKey = `betlock:${matchId}:${userId}`;
  return execute(strictMovement({
    userId, type: 'BET_LOCK', amount: -amount, refType: 'Match', refId: matchId, idempotencyKey
  }), idempotencyKey, session);
}

/** Paga el pozo al ganador. `amount` ya viene neto de comisión (lo calcula matchService). */
export async function payoutBet(matchId, winnerId, amount, { session = null } = {}) {
  assertPositiveInt(amount);
  const idempotencyKey = `betpayout:${matchId}:${winnerId}`;
  return execute(strictMovement({
    userId: winnerId, type: 'BET_PAYOUT', amount, refType: 'Match', refId: matchId, idempotencyKey
  }), idempotencyKey, session);
}

/** Devuelve la apuesta bloqueada si la partida se cancela antes de jugarse. */
export async function refundBet(matchId, userId, amount, { session = null } = {}) {
  assertPositiveInt(amount);
  const idempotencyKey = `betrefund:${matchId}:${userId}`;
  return execute(strictMovement({
    userId, type: 'BET_REFUND', amount, refType: 'Match', refId: matchId, idempotencyKey
  }), idempotencyKey, session);
}

// ─── Torneos ──────────────────────────────────────────────
// La clave de idempotencia usa el id de la inscripción (entryId): salir y volver a inscribirse
// genera movimientos nuevos, pero reintentar el mismo cobro o devolución no duplica nada.

export async function payTournamentEntry(tournamentId, userId, entryId, amount, { session = null } = {}) {
  assertPositiveInt(amount);
  const idempotencyKey = `tentry:${tournamentId}:${entryId}`;
  return execute(strictMovement({
    userId, type: 'TOURNAMENT_ENTRY', amount: -amount, refType: 'Tournament', refId: tournamentId, idempotencyKey
  }), idempotencyKey, session);
}

export async function refundTournamentEntry(tournamentId, userId, entryId, amount, { session = null } = {}) {
  assertPositiveInt(amount);
  const idempotencyKey = `trefund:${tournamentId}:${entryId}`;
  return execute(strictMovement({
    userId, type: 'TOURNAMENT_REFUND', amount, refType: 'Tournament', refId: tournamentId, idempotencyKey
  }), idempotencyKey, session);
}

/** Premio del campeón: el pozo completo menos la comisión (lo calcula tournamentService). Uno por torneo. */
export async function payTournamentPrize(tournamentId, winnerId, amount, { session = null } = {}) {
  assertPositiveInt(amount);
  const idempotencyKey = `tprize:${tournamentId}`;
  return execute(strictMovement({
    userId: winnerId, type: 'TOURNAMENT_PRIZE', amount, refType: 'Tournament', refId: tournamentId, idempotencyKey
  }), idempotencyKey, session);
}

// ─── Administración ───────────────────────────────────────

/** Ajuste manual (positivo o negativo). `operationId` lo genera el cliente para idempotencia. */
export async function adminAdjust({ userId, amount, adminId, reason, operationId }) {
  if (!Number.isInteger(amount) || amount === 0) {
    throw new AppError('El monto debe ser un entero distinto de cero', 400, 'INVALID_AMOUNT');
  }
  const idempotencyKey = `admin:${operationId}`;
  return execute(strictMovement({
    userId, type: 'ADMIN_ADJUST', amount, refType: 'User', refId: adminId, note: reason, idempotencyKey
  }), idempotencyKey);
}

// ─── Consultas ────────────────────────────────────────────

export async function getBalance(userId) {
  const user = await User.findById(userId).select('balance').lean();
  if (!user) throw new AppError('Usuario no encontrado', 404, 'NOT_FOUND');
  return user.balance;
}

export async function listLedger(userId, { skip, limit }) {
  const filter = { userId };
  const [items, total] = await Promise.all([
    LedgerEntry.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    LedgerEntry.countDocuments(filter)
  ]);
  return {
    items: items.map(e => ({
      id: e._id,
      type: e.type,
      amount: e.amount,
      balanceAfter: e.balanceAfter,
      refType: e.refType,
      refId: e.refId,
      note: e.note,
      createdAt: e.createdAt
    })),
    total
  };
}

/** Suma de todos los asientos del usuario. Debe coincidir siempre con User.balance. */
export async function getLedgerSum(userId) {
  const [row] = await LedgerEntry.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(String(userId)) } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);
  return row?.total ?? 0;
}
