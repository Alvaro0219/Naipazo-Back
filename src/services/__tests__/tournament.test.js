import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LedgerEntry } from '../../models/LedgerEntry.js';
import { Match } from '../../models/Match.js';
import { Room } from '../../models/Room.js';
import { Tournament } from '../../models/Tournament.js';
import { User } from '../../models/User.js';
import { setTestSink } from '../../sockets/emitter.js';
import * as matchService from '../matchService.js';
import * as roomService from '../roomService.js';
import * as tournamentService from '../tournamentService.js';
import { getLedgerSum } from '../walletService.js';
import { connectTestDb, disconnectTestDb, hasTestDb, resetTestDb } from './setupDb.js';
import { createUser, fakeSocket, playToEnd, waitFor } from './tableHelpers.js';

const DEFAULT_MATCH_SETTINGS = { ...matchService.settings };
const DEFAULT_TOURNAMENT_SETTINGS = { ...tournamentService.settings };
const balanceOf = async (userId) => (await User.findById(userId).lean()).balance;
const totalChips = async (users) => (await Promise.all(users.map((u) => balanceOf(u.id)))).reduce((a, b) => a + b, 0);

async function createPlayers(n, { chips = true } = {}) {
  const users = [];
  for (let i = 0; i < n; i++) users.push(await createUser({ chips, prefix: 'torneo' }));
  return users;
}

/** Crea un torneo lleno (host + invitados) y devuelve su estado. */
async function fullTournament({ size = 4, buyIn = 500, targetPoints = 15 } = {}) {
  const players = await createPlayers(size, { chips: buyIn > 0 });
  const created = await tournamentService.createTournament(players[0], { uuid: randomUUID(), size, buyIn, targetPoints });
  for (const p of players.slice(1)) await tournamentService.joinTournament(p, created.id);
  return { players, tournamentId: created.id };
}

/** Juega la partida de una llave: conecta a los dos jugadores y juega hasta el final. */
async function playBracketMatch(tournamentId, round, slot, seed = 1) {
  let match;
  await waitFor(async () => {
    const t = await Tournament.findById(tournamentId).lean();
    match = t.bracket.find((m) => m.round === round && m.slot === slot);
    return match?.status === 'playing' && matchService.getRuntime(match.matchId);
  });
  const matchId = String(match.matchId);
  for (const playerId of match.players) {
    await matchService.attachSocket(matchId, String(playerId), fakeSocket(`s-${playerId}-${matchId}`));
  }
  await playToEnd(matchId, seed);
  await waitFor(async () => {
    const t = await Tournament.findById(tournamentId).lean();
    return t.bracket.find((m) => m.round === round && m.slot === slot).status === 'finished';
  });
  return matchId;
}

describe.skipIf(!hasTestDb)('torneos (integración)', () => {
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
    setTestSink(null);
    matchService.clearRuntimes();
    tournamentService.clearTimers();
  });

  describe('inscripción', () => {
    it('crear cobra la inscripción del host, es idempotente y aparece en la lista', async () => {
      const [host] = await createPlayers(1);
      const uuid = randomUUID();
      const a = await tournamentService.createTournament(host, { uuid, size: 4, buyIn: 500, targetPoints: 15 });
      const b = await tournamentService.createTournament(host, { uuid, size: 4, buyIn: 500, targetPoints: 15 });
      expect(b.id).toBe(a.id);
      expect(a.code).toMatch(/^T[A-Z2-9]{5}$/);
      expect(a.entrants.map((e) => e.userId)).toEqual([host.id]);
      expect(a.pot).toBe(2000);
      expect(await balanceOf(host.id)).toBe(500);
      expect(await LedgerEntry.countDocuments({ type: 'TOURNAMENT_ENTRY' })).toBe(1);
      expect(emissions.some((e) => e.event === 'lobby:tournaments' && e.data[0]?.id === a.id)).toBe(true);
    });

    it('sin saldo suficiente no se inscribe ni cobra nada', async () => {
      const [host, poor] = [await createUser({ chips: true }), await createUser()];
      const t = await tournamentService.createTournament(host, { uuid: randomUUID(), size: 4, buyIn: 500, targetPoints: 15 });
      await expect(tournamentService.joinTournament(poor, t.id)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
      expect((await Tournament.findById(t.id)).entrants).toHaveLength(1);
      expect(await balanceOf(poor.id)).toBe(0);
    });

    it('inscripciones simultáneas no superan el cupo ni cobran de más', async () => {
      const [host, ...others] = await createPlayers(6);
      const t = await tournamentService.createTournament(host, { uuid: randomUUID(), size: 4, buyIn: 100, targetPoints: 15 });
      const results = await Promise.allSettled(others.map((u) => tournamentService.joinTournament(u, t.id)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      const doc = await Tournament.findById(t.id).lean();
      expect(doc.entrants).toHaveLength(4);
      expect(doc.status).toBe('playing');
      expect(await LedgerEntry.countDocuments({ type: 'TOURNAMENT_ENTRY' })).toBe(4);
      for (const u of [host, ...others]) expect(await balanceOf(u.id)).toBe(await getLedgerSum(u.id));
    });

    it('salir devuelve la inscripción, y volver a entrar y salir también', async () => {
      const [host, guest] = await createPlayers(2);
      const t = await tournamentService.createTournament(host, { uuid: randomUUID(), size: 4, buyIn: 200, targetPoints: 15 });
      await tournamentService.joinTournament(guest, t.id);
      expect(await balanceOf(guest.id)).toBe(800);
      await tournamentService.leaveTournament(guest, t.id);
      expect(await balanceOf(guest.id)).toBe(1000);
      await tournamentService.joinTournament(guest, t.id);
      await tournamentService.leaveTournament(guest, t.id);
      expect(await balanceOf(guest.id)).toBe(1000);
      expect(await LedgerEntry.countDocuments({ userId: guest.id, type: 'TOURNAMENT_REFUND' })).toBe(2);
      await expect(tournamentService.leaveTournament(host, t.id)).rejects.toMatchObject({ code: 'HOST_CANNOT_LEAVE' });
    });

    it('el host cancela y se devuelven todas las inscripciones', async () => {
      const [host, a, b] = await createPlayers(3);
      const t = await tournamentService.createTournament(host, { uuid: randomUUID(), size: 4, buyIn: 300, targetPoints: 15 });
      await tournamentService.joinTournament(a, t.id);
      await tournamentService.joinTournament(b, t.id);
      await expect(tournamentService.cancelTournament(a, t.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const cancelled = await tournamentService.cancelTournament(host, t.id);
      expect(cancelled.status).toBe('cancelled');
      for (const u of [host, a, b]) expect(await balanceOf(u.id)).toBe(1000);
      await expect(tournamentService.joinTournament(await createUser({ chips: true }), t.id))
        .rejects.toMatchObject({ code: 'TOURNAMENT_FULL' });
    });

    it('un usuario hace una sola cosa a la vez: torneo o mesa', async () => {
      const [host, other] = await createPlayers(2);
      await tournamentService.createTournament(host, { uuid: randomUUID(), size: 4, buyIn: 0, targetPoints: 15 });
      await expect(roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: 0 }))
        .rejects.toMatchObject({ code: 'ALREADY_IN_TOURNAMENT' });
      await expect(tournamentService.createTournament(host, { uuid: randomUUID(), size: 8, buyIn: 0, targetPoints: 15 }))
        .rejects.toMatchObject({ code: 'ALREADY_IN_TOURNAMENT' });
      const room = await roomService.createRoom(other, { uuid: randomUUID(), targetPoints: 15, bet: 0 });
      const t2 = await tournamentService.createTournament(await createUser(), { uuid: randomUUID(), size: 4, buyIn: 0, targetPoints: 15 });
      await expect(tournamentService.joinTournament(other, t2.id)).rejects.toMatchObject({ code: 'ALREADY_IN_ROOM' });
      expect(room.status).toBe('waiting');
    });
  });

  describe('desarrollo', () => {
    it('al completarse se sortea el cuadro y arrancan las semifinales', async () => {
      const { players, tournamentId } = await fullTournament({ size: 4, buyIn: 500 });
      const t = await Tournament.findById(tournamentId).lean();
      expect(t.status).toBe('playing');
      expect(t.bracket).toHaveLength(3);
      const firstRound = t.bracket.filter((m) => m.round === 0);
      expect(firstRound.every((m) => m.status === 'playing' && m.matchId)).toBe(true);
      expect(new Set(firstRound.flatMap((m) => m.players.map(String)))).toEqual(new Set(players.map((p) => p.id)));
      // Las partidas de torneo no tienen apuesta propia y su sala no va al lobby
      const matches = await Match.find({ tournamentId }).lean();
      expect(matches.every((m) => m.config.bet === 0 && m.round === 0)).toBe(true);
      expect(await Room.countDocuments({ tournamentId, status: 'waiting' })).toBe(0);
      // Cada jugador recibe el aviso de su partida
      const notices = emissions.filter((e) => e.event === 'tournament:match');
      expect(new Set(notices.map((e) => e.target))).toEqual(new Set(players.map((p) => `user:${p.id}`)));
    });

    it('torneo de 4 completo: el campeón cobra todo el pozo y las fichas solo cambian de dueño', async () => {
      const players = await createPlayers(4);
      const before = await totalChips(players);
      const created = await tournamentService.createTournament(players[0], { uuid: randomUUID(), size: 4, buyIn: 500, targetPoints: 15 });
      for (const p of players.slice(1)) await tournamentService.joinTournament(p, created.id);

      await playBracketMatch(created.id, 0, 0, 11);
      await playBracketMatch(created.id, 0, 1, 22);
      await playBracketMatch(created.id, 1, 0, 33);

      await waitFor(async () => (await Tournament.findById(created.id).lean()).status === 'finished');
      const t = await Tournament.findById(created.id).lean();
      const final = t.bracket.find((m) => m.round === 1);
      expect(String(t.winnerId)).toBe(String(final.winnerId));
      expect(t.prize).toBe(2000);
      await waitFor(async () => (await Tournament.findById(created.id).lean()).settled);

      const prizes = await LedgerEntry.find({ type: 'TOURNAMENT_PRIZE' }).lean();
      expect(prizes).toHaveLength(1);
      expect(prizes[0].amount).toBe(2000);
      expect(String(prizes[0].userId)).toBe(String(t.winnerId));
      expect(await balanceOf(String(t.winnerId))).toBe(2500);
      expect(await totalChips(players)).toBe(before);
      for (const p of players) expect(await balanceOf(p.id)).toBe(await getLedgerSum(p.id));

      // Eliminados marcados, estadísticas de torneo
      expect(t.entrants.filter((e) => e.eliminated)).toHaveLength(3);
      const champion = await User.findById(t.winnerId).lean();
      expect(champion.stats.tournamentsWon).toBe(1);
      expect(champion.stats.tournamentsPlayed).toBe(1);
      expect(champion.stats.chipsWon).toBe(1500);

      // Liquidar otra vez no paga dos veces
      await Tournament.updateOne({ _id: created.id }, { settled: false });
      await tournamentService.settleTournament(created.id);
      expect(await LedgerEntry.countDocuments({ type: 'TOURNAMENT_PRIZE' })).toBe(1);
    }, 60000);

    it('torneo de 8 completo (cuartos, semis y final)', async () => {
      const { tournamentId } = await fullTournament({ size: 8, buyIn: 100 });
      for (let slot = 0; slot < 4; slot++) await playBracketMatch(tournamentId, 0, slot, 100 + slot);
      for (let slot = 0; slot < 2; slot++) await playBracketMatch(tournamentId, 1, slot, 200 + slot);
      await playBracketMatch(tournamentId, 2, 0, 300);
      await waitFor(async () => (await Tournament.findById(tournamentId).lean()).status === 'finished');
      const t = await Tournament.findById(tournamentId).lean();
      expect(t.prize).toBe(800);
      expect(t.bracket.every((m) => m.status === 'finished')).toBe(true);
      expect(await Match.countDocuments({ tournamentId, status: 'finished' })).toBe(7);
    }, 120000);

    it('abandonar una partida del torneo hace avanzar al rival', async () => {
      const { tournamentId } = await fullTournament({ size: 4, buyIn: 0 });
      const t = await Tournament.findById(tournamentId).lean();
      const semi = t.bracket.find((m) => m.round === 0 && m.slot === 0);
      const [quitter, rival] = semi.players.map(String);
      await matchService.attachSocket(String(semi.matchId), quitter, fakeSocket('q'));
      await matchService.abandonMatch(quitter, String(semi.matchId));
      await waitFor(async () => {
        const doc = await Tournament.findById(tournamentId).lean();
        return doc.bracket.find((m) => m.round === 1).players.map(String).includes(rival);
      });
      const doc = await Tournament.findById(tournamentId).lean();
      expect(String(doc.bracket[0].winnerId)).toBe(rival);
      expect(doc.entrants.find((e) => String(e.userId) === quitter).eliminated).toBe(true);
      // El eliminado queda libre para jugar otra mesa
      await expect(roomService.createRoom({ id: quitter, username: 'x' }, { uuid: randomUUID(), targetPoints: 15, bet: 0 }))
        .resolves.toMatchObject({ status: 'waiting' });
    });

    it('al reiniciar el servidor se cancela y devuelve todas las inscripciones', async () => {
      const { players, tournamentId } = await fullTournament({ size: 4, buyIn: 250 });
      matchService.clearRuntimes();
      await tournamentService.recoverOnStartup();
      const t = await Tournament.findById(tournamentId).lean();
      expect(t.status).toBe('cancelled');
      expect(t.settled).toBe(true);
      for (const p of players) expect(await balanceOf(p.id)).toBe(1000);
    });
  });
});
