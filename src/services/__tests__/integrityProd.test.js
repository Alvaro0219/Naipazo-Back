// Verificación en producción (EXACTITUD_DEL_JUEGO.md, sección 10): congelamiento por invariante roto,
// auditoría de partidas terminadas y conciliación de fichas.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAvailableActions } from '../../game/truco/index.js';
import { Incident } from '../../models/Incident.js';
import { Match } from '../../models/Match.js';
import { MatchHandLog } from '../../models/MatchHandLog.js';
import { Room } from '../../models/Room.js';
import { Tournament } from '../../models/Tournament.js';
import { User } from '../../models/User.js';
import { setTestSink } from '../../sockets/emitter.js';
import * as integrityService from '../integrityService.js';
import * as matchService from '../matchService.js';
import * as tournamentService from '../tournamentService.js';
import { connectTestDb, disconnectTestDb, hasTestDb, resetTestDb } from './setupDb.js';
import {
  createUser, fakeSocket, playToEnd, startTable, waitFor
} from './tableHelpers.js';

const DEFAULT_MATCH_SETTINGS = { ...matchService.settings };
const DEFAULT_TOURNAMENT_SETTINGS = { ...tournamentService.settings };
const DEFAULT_INTEGRITY_SETTINGS = { ...integrityService.settings };
const balanceOf = async (userId) => (await User.findById(userId).lean()).balance;
const BROKEN = () => [{ id: 'I-TEST', message: 'invariante roto a propósito' }];

/** Primera acción disponible de quien tenga que actuar. */
function anyAction(matchId) {
  const rt = matchService.getRuntime(matchId);
  const actor = rt.state.players.find((p) => getAvailableActions(rt.state, p.id).includes('PLAY_CARD'));
  return { actor: actor.id, cardId: rt.state.hand.cards[actor.id][0] };
}

describe.skipIf(!hasTestDb)('integridad en producción (integración)', () => {
  let emissions;

  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    await resetTestDb();
    Object.assign(matchService.settings, DEFAULT_MATCH_SETTINGS, { nextHandDelayMs: 0 });
    Object.assign(tournamentService.settings, DEFAULT_TOURNAMENT_SETTINGS, { nextMatchDelayMs: 0 });
    emissions = [];
    setTestSink((e) => emissions.push(e));
  });
  afterEach(() => {
    Object.assign(integrityService.settings, DEFAULT_INTEGRITY_SETTINGS);
    setTestSink(null);
    matchService.clearRuntimes();
    tournamentService.clearTimers();
  });

  describe('10.1 congelamiento', () => {
    it('R-ECO-05: un invariante roto congela la partida, devuelve las apuestas y registra el incidente', async () => {
      const { host, guest, matchId, room } = await startTable({ bet: 100 });
      expect(await balanceOf(host.id)).toBe(900);
      integrityService.settings.check = BROKEN;

      const { actor, cardId } = anyAction(matchId);
      const res = await matchService.handleAction(actor, { matchId, actionId: randomUUID(), type: 'PLAY_CARD', payload: { cardId } });
      expect(res).toEqual({ frozen: true });

      await waitFor(async () => (await Match.findById(matchId).lean()).betsSettled);
      const match = await Match.findById(matchId).lean();
      expect(match).toMatchObject({ status: 'cancelled', endReason: 'frozen' });
      expect((await Room.findById(room.id).lean()).cancelReason).toBe('frozen');
      expect(await balanceOf(host.id)).toBe(1000);
      expect(await balanceOf(guest.id)).toBe(1000);

      await waitFor(async () => (await Incident.countDocuments({ type: 'invariant' })) === 1);
      const incident = await Incident.findOne({ type: 'invariant' }).lean();
      expect(String(incident.matchId)).toBe(matchId);
      expect(incident.summary).toContain('I-TEST');
      expect(incident.details.violations).toHaveLength(1);
      expect(incident.details.next).toBeTruthy();

      // El estado roto nunca se publica: solo el aviso de congelamiento
      await waitFor(() => emissions.some((e) => e.event === 'game:frozen'));
      expect(emissions.find((e) => e.event === 'game:frozen').data.message).toMatch(/devolvieron las fichas/);
      expect(matchService.getRuntime(matchId).frozen).toBe(true);
      await expect(matchService.handleAction(actor, { matchId, actionId: randomUUID(), type: 'GO_TO_DECK', payload: {} }))
        .rejects.toBeTruthy();

      // La conciliación sigue cuadrando: no se crearon ni perdieron fichas
      expect((await integrityService.reconcile()).ok).toBe(true);
    });

    it('R-ECO-05: si se congela una partida de torneo, el torneo se cancela y se devuelven las inscripciones', async () => {
      const players = [];
      for (let i = 0; i < 4; i++) players.push(await createUser({ chips: true, prefix: 'congela' }));
      const created = await tournamentService.createTournament(players[0], { uuid: randomUUID(), size: 4, buyIn: 500, targetPoints: 15 });
      for (const p of players.slice(1)) await tournamentService.joinTournament(p, created.id);

      let bracketMatch;
      await waitFor(async () => {
        const t = await Tournament.findById(created.id).lean();
        bracketMatch = t.bracket.find((m) => m.round === 0 && m.status === 'playing');
        return bracketMatch && matchService.getRuntime(String(bracketMatch.matchId));
      });
      const matchId = String(bracketMatch.matchId);
      for (const id of bracketMatch.players) await matchService.attachSocket(matchId, String(id), fakeSocket(`s-${id}`));

      integrityService.settings.check = BROKEN;
      const { actor, cardId } = anyAction(matchId);
      await matchService.handleAction(actor, { matchId, actionId: randomUUID(), type: 'PLAY_CARD', payload: { cardId } });

      await waitFor(async () => {
        const t = await Tournament.findById(created.id).lean();
        return t.status === 'cancelled' && t.settled;
      });
      for (const p of players) expect(await balanceOf(p.id)).toBe(1000);
      integrityService.settings.check = DEFAULT_INTEGRITY_SETTINGS.check;
      expect((await integrityService.reconcile()).ok).toBe(true);
    });
  });

  describe('10.2 auditoría', () => {
    it('R-ECO-01: una partida jugada normalmente pasa la auditoría (repetición y pagos)', async () => {
      const { matchId } = await startTable({ bet: 100 });
      await playToEnd(matchId, 777);
      await waitFor(async () => (await Match.findById(matchId).lean()).betsSettled);

      const result = await integrityService.auditMatch(matchId);
      expect(result).toEqual({ status: 'ok', diffs: [] });
      expect((await Match.findById(matchId).lean()).audit.status).toBe('ok');
      expect(await Incident.countDocuments({})).toBe(0);
    });

    it('R-ECO-01: un registro adulterado no pasa la auditoría y queda un incidente', async () => {
      const { matchId } = await startTable({ bet: 100 });
      await playToEnd(matchId, 4242);
      await waitFor(async () => (await Match.findById(matchId).lean()).betsSettled);

      // Se toca el puntaje guardado y el reparto de la primera mano
      const match = await Match.findById(matchId).lean();
      await Match.updateOne({ _id: matchId }, { score: [match.score[0] + 1, match.score[1]] });
      const first = await MatchHandLog.findOne({ matchId, handNumber: 1 }).lean();
      const [a, b] = Object.keys(first.dealt);
      await MatchHandLog.updateOne({ _id: first._id }, { dealt: { [a]: first.dealt[b], [b]: first.dealt[a] } });

      const result = await integrityService.auditMatch(matchId);
      expect(result.status).toBe('failed');
      expect(result.diffs.some((d) => d.includes('puntaje final'))).toBe(true);
      expect(result.diffs.some((d) => d.includes('reparto'))).toBe(true);
      expect((await Match.findById(matchId).lean()).audit.status).toBe('failed');
      expect(await Incident.countDocuments({ type: 'audit', matchId })).toBe(1);

      const summary = await integrityService.getIntegritySummary();
      expect(summary.open.audit).toBe(1);
      expect(summary.failedAudits).toBe(1);
      await integrityService.resolveIncident(summary.recent[0].id);
      expect((await integrityService.getIntegritySummary()).open.audit).toBe(0);
    });

    it('R-REP-03: cada mano usa un barajado nuevo; el mazo no se repite entre manos ni entre partidas', async () => {
      const first = await startTable();
      await playToEnd(first.matchId, 11);
      const second = await startTable();
      await playToEnd(second.matchId, 11); // mismas decisiones: solo el mazo cambia
      const decks = (await MatchHandLog.find({ matchId: { $in: [first.matchId, second.matchId] } }).lean()).map((l) => l.deck.join(','));
      expect(decks.length).toBeGreaterThan(4);
      expect(new Set(decks).size).toBe(decks.length);
    });

    it('R-ECO-01: una partida ganada por abandono también se audita bien', async () => {
      const { host, matchId } = await startTable({ bet: 100 });
      await matchService.abandonMatch(host.id, matchId);
      await waitFor(async () => (await Match.findById(matchId).lean()).betsSettled);
      expect((await integrityService.auditMatch(matchId)).status).toBe('ok');
    });
  });

  describe('10.3 conciliación', () => {
    it('I-E2/I-E3: cuadra después de partidas con apuesta y detecta un saldo tocado a mano', async () => {
      const t1 = await startTable({ bet: 100 });
      await playToEnd(t1.matchId, 99);
      const t2 = await startTable({ bet: 50 }); // queda en juego: sus apuestas están retenidas
      await waitFor(async () => (await Match.findById(t1.matchId).lean()).betsSettled);

      const ok = await integrityService.reconcile();
      expect(ok.problems).toEqual([]);
      expect(ok.ok).toBe(true);
      expect(ok.checkedMatches).toBe(1);

      await User.updateOne({ _id: t2.host.id }, { $inc: { balance: 7 } });
      const bad = await integrityService.reconcile();
      expect(bad.ok).toBe(false);
      expect(bad.problems).toEqual([expect.objectContaining({ check: 'I-E2', user: t2.host.username })]);
      expect(await Incident.countDocuments({ type: 'reconciliation' })).toBe(1);
    });
  });
});
