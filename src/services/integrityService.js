import {
  PHASES, RULES_VERSION, applyAction, applyTimeout, createMatchState, dealNextHand, forfeitMatch
} from '../game/truco/index.js';
import { env } from '../config/env.js';
import { checkInvariants } from '../game/truco/invariants.js';
import { Incident } from '../models/Incident.js';
import { LedgerEntry } from '../models/LedgerEntry.js';
import { Match } from '../models/Match.js';
import { MatchHandLog } from '../models/MatchHandLog.js';
import { Tournament } from '../models/Tournament.js';
import { User } from '../models/User.js';
import { computeSettlement } from './betService.js';

// Verificación en producción (EXACTITUD_DEL_JUEGO.md, sección 10):
//  10.1 invariantes después de cada acción (matchService congela la partida si alguno falla)
//  10.2 auditoría de cada partida terminada: se vuelve a jugar desde el MatchHandLog y se compara
//  10.3 conciliación diaria de fichas
//  10.4 resumen para el panel de admin

export const settings = {
  // Reemplazable en tests para simular un invariante roto
  check: checkInvariants,
  // En los tests se audita a mano (auditMatch): una auditoría en segundo plano chocaría con la base ya borrada
  auditEnabled: env.nodeEnv !== 'test',
  reconcileEveryMs: 24 * 60 * 60 * 1000
};

export async function recordIncident(type, summary, { matchId = null, details = null, rulesVersion = null } = {}) {
  console.error(`[INTEGRIDAD] ${type}: ${summary}${matchId ? ` (partida ${matchId})` : ''}`);
  try {
    return await Incident.create({ type, summary, matchId, details, rulesVersion });
  } catch (err) {
    console.error('No se pudo registrar el incidente:', err);
    return null;
  }
}

/** 10.1: violaciones de invariantes entre el estado anterior y el nuevo (lista vacía = todo bien). */
export function verifyTransition(prev, next) {
  try {
    return settings.check(next, prev);
  } catch (err) {
    return [{ id: 'CHECK_ERROR', message: err.message }];
  }
}

// ─── 10.2 Auditoría ─────────────────────────────────────

/**
 * Vuelve a jugar una partida desde su registro (mazo y acciones de cada mano) con el motor y devuelve las
 * diferencias con lo que quedó guardado. Lista vacía = la partida se jugó exactamente según las reglas.
 */
export function replayMatch(match, logs) {
  const diffs = [];
  const players = [...match.players].sort((a, b) => a.seat - b.seat);
  const ids = players.map((p) => String(p.userId));
  const n = ids.length;
  const ordered = [...logs].sort((a, b) => a.handNumber - b.handNumber);
  if (!ordered.length) return { diffs, state: null };

  const firstMano = ids.indexOf(ordered[0].manoId);
  let state = createMatchState({
    config: { targetPoints: match.config.targetPoints },
    playerIds: ids,
    dealerSeat: (firstMano - 1 + n) % n
  });

  for (const log of ordered) {
    if (state.phase === PHASES.FINISHED) {
      diffs.push(`hay una mano ${log.handNumber} después del final`);
      break;
    }
    try {
      state = dealNextHand(state, log.deck).state;
    } catch (err) {
      diffs.push(`mano ${log.handNumber}: no se pudo repartir (${err.message})`);
      break;
    }
    if (state.players[state.hand.manoSeat].id !== log.manoId) diffs.push(`mano ${log.handNumber}: el mano no coincide`);
    if (JSON.stringify(state.hand.dealt) !== JSON.stringify(log.dealt)) diffs.push(`mano ${log.handNumber}: el reparto no coincide`);
    for (const e of log.events) {
      try {
        if (e.action === 'TIMEOUT') state = applyTimeout(state).state;
        else if (e.action === 'ABANDON') state = forfeitMatch(state, state.players.find((p) => p.id === e.playerId).team, 'abandon').state;
        else state = applyAction(state, e.playerId, { type: e.action, payload: e.payload || {} }).state;
      } catch (err) {
        diffs.push(`mano ${log.handNumber}: la acción ${e.action} de ${e.playerId} no es válida al repetirla (${err.message})`);
      }
    }
    const result = state.hand?.result ?? null;
    if (JSON.stringify(result) !== JSON.stringify(log.result ?? null)) {
      diffs.push(`mano ${log.handNumber}: resultado ${JSON.stringify(result)} ≠ guardado ${JSON.stringify(log.result)}`);
    }
    if (JSON.stringify(state.score) !== JSON.stringify(log.scoreAfter)) {
      diffs.push(`mano ${log.handNumber}: puntaje ${state.score} ≠ guardado ${log.scoreAfter}`);
    }
  }

  // Un abandono entre manos no queda en ningún registro de mano: se aplica al final
  if (state.phase !== PHASES.FINISHED && match.endReason === 'abandon' && match.abandonedBy) {
    const team = state.players.find((p) => p.id === String(match.abandonedBy))?.team;
    if (team !== undefined) state = forfeitMatch(state, team, 'abandon').state;
  }
  if (match.status === 'finished') {
    if (state.phase !== PHASES.FINISHED) diffs.push('al repetirla, la partida no termina');
    if (state.winnerTeam !== match.winnerTeam) diffs.push(`ganador ${state.winnerTeam} ≠ guardado ${match.winnerTeam}`);
    if (JSON.stringify(state.score) !== JSON.stringify(match.score)) diffs.push(`puntaje final ${state.score} ≠ guardado ${match.score}`);
    if (state.endReason !== match.endReason) diffs.push(`motivo ${state.endReason} ≠ guardado ${match.endReason}`);
  }
  return { diffs, state };
}

/** Audita una partida terminada: repetición + pagos. Marca Match.audit y registra un incidente si no coincide. */
export async function auditMatch(matchId) {
  const match = await Match.findById(matchId).lean();
  if (!match || match.status !== 'finished') return null;
  if ((match.rulesVersion ?? 1) !== RULES_VERSION) {
    // Una versión de reglas vieja se audita con su motor; hoy hay una sola versión
    await Match.updateOne({ _id: matchId }, { audit: { status: 'skipped', checkedAt: new Date(), diffs: ['versión de reglas distinta'] } });
    return { status: 'skipped' };
  }
  const logs = await MatchHandLog.find({ matchId }).lean();
  const { diffs } = replayMatch(match, logs);

  // Pagos: lo acreditado en el ledger tiene que ser exactamente lo que dicen las reglas
  if (match.betsSettled && (match.config.bet || 0) > 0) {
    const { payouts } = computeSettlement(match);
    const paid = await LedgerEntry.find({ refType: 'Match', refId: match._id, type: 'BET_PAYOUT' }).lean();
    const byUser = (list, key) => Object.fromEntries(list.map((x) => [String(x[key]), x.amount]));
    const expected = byUser(payouts, 'userId');
    const actual = byUser(paid, 'userId');
    if (JSON.stringify(Object.entries(expected).sort()) !== JSON.stringify(Object.entries(actual).sort())) {
      diffs.push(`pagos ${JSON.stringify(actual)} ≠ esperados ${JSON.stringify(expected)}`);
    }
  }

  const status = diffs.length ? 'failed' : 'ok';
  await Match.updateOne({ _id: matchId }, { audit: { status, checkedAt: new Date(), diffs } });
  if (diffs.length) {
    await recordIncident('audit', `La auditoría de la partida no coincide (${diffs.length} diferencia/s)`, {
      matchId, details: { diffs }, rulesVersion: match.rulesVersion ?? 1
    });
  }
  return { status, diffs };
}

// ─── 10.3 Conciliación de fichas ────────────────────────

/**
 * Conciliación: saldo = suma del ledger (I-E2); cada partida liquidada cuadra (I-E3); cada torneo cerrado cuadra
 * (I-E4); y conservación global: lo que salió de los jugadores = lo retenido en juego + lo que quedó en la casa.
 */
export async function reconcile() {
  const problems = [];

  const sums = await LedgerEntry.aggregate([{ $group: { _id: '$userId', total: { $sum: '$amount' } } }]);
  const ledgerByUser = new Map(sums.map((s) => [String(s._id), s.total]));
  const users = await User.find({}).select('balance username').lean();
  for (const u of users) {
    const total = ledgerByUser.get(String(u._id)) ?? 0;
    if (!Number.isInteger(u.balance) || u.balance < 0) problems.push({ check: 'I-E1', user: u.username, balance: u.balance });
    if (total !== u.balance) problems.push({ check: 'I-E2', user: u.username, balance: u.balance, ledger: total });
  }

  // I-E3: partidas liquidadas — lo bloqueado = pagado + devuelto + casa
  const settled = await Match.find({ betsSettled: true, 'config.bet': { $gt: 0 }, status: { $in: ['finished', 'cancelled'] } })
    .select('players houseCut status').lean();
  const moves = await LedgerEntry.aggregate([
    { $match: { refType: 'Match', type: { $in: ['BET_LOCK', 'BET_PAYOUT', 'BET_REFUND'] } } },
    { $group: { _id: { match: '$refId', type: '$type' }, total: { $sum: '$amount' } } }
  ]);
  const byMatch = new Map();
  for (const m of moves) {
    const key = String(m._id.match);
    byMatch.set(key, { ...(byMatch.get(key) || {}), [m._id.type]: m.total });
  }
  let houseTotal = 0;
  for (const m of settled) {
    const mv = byMatch.get(String(m._id)) || {};
    const locked = -(mv.BET_LOCK || 0);
    const back = (mv.BET_PAYOUT || 0) + (mv.BET_REFUND || 0);
    const house = m.status === 'finished' ? (m.houseCut || 0) : 0;
    houseTotal += house;
    if (locked !== back + house) problems.push({ check: 'I-E3', match: String(m._id), locked, paid: back, house });
  }

  // I-E4: torneos cerrados — inscripciones = premio + devoluciones + comisión
  const tournaments = await Tournament.find({ settled: true, status: { $in: ['finished', 'cancelled'] } }).select('prize status').lean();
  const tMoves = await LedgerEntry.aggregate([
    { $match: { refType: 'Tournament' } },
    { $group: { _id: { t: '$refId', type: '$type' }, total: { $sum: '$amount' } } }
  ]);
  const byT = new Map();
  for (const m of tMoves) {
    const key = String(m._id.t);
    byT.set(key, { ...(byT.get(key) || {}), [m._id.type]: m.total });
  }
  for (const t of tournaments) {
    const mv = byT.get(String(t._id)) || {};
    const entries = -(mv.TOURNAMENT_ENTRY || 0);
    const out = (mv.TOURNAMENT_PRIZE || 0) + (mv.TOURNAMENT_REFUND || 0);
    const commission = t.status === 'finished' ? entries - out : 0;
    if (commission < 0 || (t.status === 'cancelled' && entries !== out)) {
      problems.push({ check: 'I-E4', tournament: String(t._id), entries, out });
    }
    houseTotal += Math.max(0, commission);
  }

  // Conservación global: lo que salió de los jugadores por apuestas e inscripciones (y no volvió) tiene que estar
  // retenido en partidas o torneos todavía abiertos, o haber quedado en la casa. Nunca se crean ni se pierden fichas.
  const heldAgg = await LedgerEntry.aggregate([
    { $match: { type: { $in: ['BET_LOCK', 'BET_PAYOUT', 'BET_REFUND', 'TOURNAMENT_ENTRY', 'TOURNAMENT_PRIZE', 'TOURNAMENT_REFUND'] } } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);
  const outOfPlayers = -(heldAgg[0]?.total ?? 0);
  const openMatches = await Match.find({ betsSettled: false }).select('_id').lean();
  let heldOpen = 0;
  for (const m of openMatches) {
    const mv = byMatch.get(String(m._id)) || {};
    heldOpen += -((mv.BET_LOCK || 0) + (mv.BET_PAYOUT || 0) + (mv.BET_REFUND || 0));
  }
  const openTournaments = await Tournament.find({ $or: [{ settled: false }, { status: { $in: ['waiting', 'playing'] } }] }).select('_id').lean();
  for (const t of openTournaments) {
    const mv = byT.get(String(t._id)) || {};
    heldOpen += -((mv.TOURNAMENT_ENTRY || 0) + (mv.TOURNAMENT_PRIZE || 0) + (mv.TOURNAMENT_REFUND || 0));
  }
  if (outOfPlayers !== heldOpen + houseTotal) {
    problems.push({ check: 'conservación', salieron: outOfPlayers, retenidas: heldOpen, casa: houseTotal });
  }

  if (problems.length) {
    await recordIncident('reconciliation', `La conciliación de fichas encontró ${problems.length} diferencia/s`, { details: { problems } });
  }
  return { ok: problems.length === 0, problems, checkedUsers: users.length, checkedMatches: settled.length, checkedTournaments: tournaments.length };
}

let reconcileTimer = null;
export function startIntegrityScheduler() {
  if (reconcileTimer) return;
  const run = () => reconcile().catch((err) => console.error('No se pudo conciliar las fichas:', err));
  setTimeout(run, 60 * 1000).unref?.();
  reconcileTimer = setInterval(run, settings.reconcileEveryMs);
  reconcileTimer.unref?.();
}

// ─── 10.4 Panel de admin ────────────────────────────────

export async function getIntegritySummary() {
  const [byType, frozen, failedAudits, recent] = await Promise.all([
    Incident.aggregate([{ $match: { resolved: false } }, { $group: { _id: '$type', n: { $sum: 1 } } }]),
    Match.countDocuments({ endReason: 'frozen' }),
    Match.countDocuments({ 'audit.status': 'failed' }),
    Incident.find({}).sort({ createdAt: -1 }).limit(20).lean()
  ]);
  const counts = Object.fromEntries(byType.map((x) => [x._id, x.n]));
  return {
    open: { invariant: counts.invariant || 0, audit: counts.audit || 0, reconciliation: counts.reconciliation || 0 },
    frozenMatches: frozen,
    failedAudits,
    recent: recent.map((i) => ({
      id: String(i._id), type: i.type, summary: i.summary, matchId: i.matchId ? String(i.matchId) : null, resolved: i.resolved, createdAt: i.createdAt
    }))
  };
}

export async function resolveIncident(id) {
  await Incident.updateOne({ _id: id }, { resolved: true });
}
