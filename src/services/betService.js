import { env } from '../config/env.js';
import { Match } from '../models/Match.js';
import { houseFee } from '../utils/houseFee.js';
import * as emitter from '../sockets/emitter.js';
import { getBalance, payoutBet, refundBet } from './walletService.js';

// Liquidación de las apuestas de una partida: pago del pozo al ganador o devolución si se canceló.
// Todo pasa por walletService (idempotente por partida y jugador), así que se puede reintentar sin
// riesgo: si el server se cae a mitad de camino, settlePendingBets lo completa al arrancar.

/** Cuánto cobra cada ganador: el pozo completo menos la comisión de la casa (HOUSE_RATE). */
export function computePayouts({ players, winnerTeam }, houseRate = env.houseRate) {
  const pot = players.reduce((sum, p) => sum + (p.betLocked || 0), 0);
  if (pot === 0 || winnerTeam === null || winnerTeam === undefined) return [];
  const net = pot - houseFee(pot, houseRate);
  const winners = players.filter((p) => p.team === winnerTeam);
  const share = Math.floor(net / winners.length);
  return winners.map((w) => ({ userId: String(w.userId), amount: share }));
}

/**
 * Pagos y devoluciones de una partida terminada: el pozo se reparte entre los ganadores (computePayouts).
 * En 2 vs 2, si abandona uno pierden los dos de la pareja (*Decisión del dueño*): cada rival cobra 2 apuestas,
 * como en una partida normal. Hoy no hay devoluciones en partidas terminadas (`refunds` queda para el futuro).
 */
export function computeSettlement(match, houseRate = env.houseRate) {
  const payouts = computePayouts(match, houseRate);
  const refunds = [];
  const pot = match.players.reduce((sum, p) => sum + (p.betLocked || 0), 0);
  const paid = [...payouts, ...refunds].reduce((sum, p) => sum + p.amount, 0);
  // D-10: la comisión y el resto de dividir entre ganadores quedan en la casa (lo bloqueado = pagado + devuelto + casa)
  return { payouts, refunds, houseCut: pot - paid };
}

/** Resumen de fichas por jugador para el cliente: { bet, pot, players: [{ userId, bet, received, net }] }. */
export function buildChipsSummary(match) {
  const bet = match.config?.bet || 0;
  if (!bet) return null;
  const received = new Map();
  if (match.status === 'finished') {
    const { payouts, refunds } = computeSettlement(match);
    for (const p of [...payouts, ...refunds]) received.set(p.userId, (received.get(p.userId) || 0) + p.amount);
  } else if (match.status === 'cancelled') {
    for (const p of match.players) received.set(String(p.userId), p.betLocked || 0);
  }
  return {
    bet,
    pot: match.players.reduce((sum, p) => sum + (p.betLocked || 0), 0),
    players: match.players.map((p) => {
      const userId = String(p.userId);
      const got = received.get(userId) || 0;
      return { userId, bet: p.betLocked || 0, received: got, net: got - (p.betLocked || 0) };
    })
  };
}

/** Avisa a cada usuario su saldo actualizado (barra superior del front). */
export async function notifyBalances(userIds) {
  for (const id of userIds) {
    const userId = String(id);
    try {
      emitter.toUser(userId, 'wallet:update', { balance: await getBalance(userId) });
    } catch (err) {
      console.error('No se pudo avisar el saldo actualizado:', err);
    }
  }
}

/** Paga o devuelve las apuestas de una partida terminada o cancelada. Idempotente. */
export async function settleMatchBets(matchId) {
  const match = await Match.findById(matchId).lean();
  if (!match || match.betsSettled) return match ? buildChipsSummary(match) : null;

  if (match.status === 'finished') {
    const { payouts, refunds } = computeSettlement(match);
    for (const { userId, amount } of payouts) {
      if (amount > 0) await payoutBet(match._id, userId, amount);
    }
    for (const { userId, amount } of refunds) await refundBet(match._id, userId, amount);
  } else if (match.status === 'cancelled') {
    for (const p of match.players) {
      if (p.betLocked > 0) await refundBet(match._id, p.userId, p.betLocked);
    }
  } else {
    return null; // sigue en juego
  }

  const houseCut = match.status === 'finished' ? computeSettlement(match).houseCut : 0;
  await Match.updateOne({ _id: match._id, betsSettled: false }, { betsSettled: true, houseCut });
  await notifyBalances(match.players.map((p) => p.userId));
  return buildChipsSummary(match);
}

/** Al arrancar: completa cualquier liquidación pendiente (partidas terminadas o canceladas sin pagar). */
export async function settlePendingBets() {
  const pending = await Match.find({ betsSettled: false, status: { $in: ['finished', 'cancelled'] } })
    .select('_id').lean();
  for (const { _id } of pending) {
    try {
      await settleMatchBets(_id);
    } catch (err) {
      console.error(`No se pudieron liquidar las apuestas de la partida ${_id}:`, err);
    }
  }
  return pending.length;
}
