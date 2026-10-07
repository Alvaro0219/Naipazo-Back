import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Match } from '../../models/Match.js';
import { MatchHandLog } from '../../models/MatchHandLog.js';
import { Room } from '../../models/Room.js';
import { User } from '../../models/User.js';
import { getAvailableActions } from '../../game/truco/index.js';
import { setTestSink } from '../../sockets/emitter.js';
import * as adminService from '../adminService.js';
import { settleMatchBets } from '../betService.js';
import * as historyService from '../historyService.js';
import { getRanking } from '../rankingService.js';
import * as matchService from '../matchService.js';
import * as rematchService from '../rematchService.js';
import * as roomService from '../roomService.js';
import { adminAdjust, getLedgerSum } from '../walletService.js';
import { connectTestDb, disconnectTestDb, hasTestDb, resetTestDb } from './setupDb.js';
import { createUser, fakeSocket, playToEnd, waitFor } from './tableHelpers.js';

const DEFAULT_MATCH_SETTINGS = { ...matchService.settings };
const balanceOf = async (id) => (await User.findById(id).lean()).balance;
const create2v2 = (host, { bet = 0, isPrivate = false } = {}) => roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet, isPrivate, mode: '2v2' });

/** Mesa 2 vs 2 completa: host en el asiento 0 y tres invitados en 1, 2 y 3. Devuelve los jugadores por asiento. */
async function fullTable({ bet = 0 } = {}) {
  const players = [];
  for (let i = 0; i < 4; i++) players.push(await createUser({ chips: true, prefix: 'pareja' }));
  const room = await create2v2(players[0], { bet });
  for (const [i, p] of players.slice(1).entries()) await roomService.joinRoom(p, room.id, { seat: i + 1 });
  const doc = await Room.findById(room.id).lean();
  const sockets = {};
  for (const p of players) {
    sockets[p.id] = fakeSocket(`s-${p.id}`);
    await matchService.attachSocket(String(doc.matchId), p.id, sockets[p.id]);
  }
  return { players, room: doc, matchId: String(doc.matchId), sockets };
}

describe.skipIf(!hasTestDb)('2 vs 2 (integración)', () => {
  let emissions;
  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    await resetTestDb();
    Object.assign(matchService.settings, DEFAULT_MATCH_SETTINGS, { nextHandDelayMs: 0 });
    emissions = [];
    setTestSink((e) => emissions.push(e));
  });
  afterEach(() => {
    setTestSink(null);
    rematchService.clearPending();
    matchService.clearRuntimes();
  });

  describe('salas y asientos', () => {
    it('crea la sala con 4 asientos; en 2 vs 2 la apuesta es múltiplo de 10', async () => {
      const host = await createUser({ chips: true });
      await expect(create2v2(host, { bet: 15 })).rejects.toMatchObject({ code: 'BET_NOT_MULTIPLE_OF_10' });
      const room = await create2v2(host, { bet: 20 });
      expect(room.config).toMatchObject({ mode: '2v2', maxPlayers: 4, bet: 20 });
      expect(room.seats).toEqual([expect.objectContaining({ userId: host.id, seat: 0, team: 0 })]);
      expect((await roomService.listOpenRooms({ mode: '2v2' }, { skip: 0, limit: 10 })).total).toBe(1);
      expect((await roomService.listOpenRooms({ mode: '1v1' }, { skip: 0, limit: 10 })).total).toBe(0);
    });

    it('se une en el asiento pedido o en el primero libre; un asiento ocupado se rechaza', async () => {
      const [host, a, b, c] = [await createUser(), await createUser(), await createUser(), await createUser()];
      const room = await create2v2(host);
      let r = await roomService.joinRoom(a, room.id, { seat: 2 });
      expect(r.seats.map((s) => [s.seat, s.team])).toEqual([[0, 0], [2, 0]]);
      await expect(roomService.joinRoom(b, room.id, { seat: 2 })).rejects.toMatchObject({ code: 'SEAT_TAKEN' });
      r = await roomService.joinRoom(b, room.id);
      expect(r.seats.find((s) => s.userId === b.id).seat).toBe(1);
      expect(r.status).toBe('waiting');
      // Con 3 de 4 no arranca; el cuarto completa y arranca
      r = await roomService.joinRoom(c, room.id);
      expect(r.status).toBe('playing');
      expect(matchService.getRuntime(r.matchId).players).toHaveLength(4);
    });

    it('cambiar de asiento solo a uno libre, en espera y solo en 2 vs 2', async () => {
      const [host, a] = [await createUser(), await createUser()];
      const room = await create2v2(host);
      await roomService.joinRoom(a, room.id, { seat: 1 });
      const moved = await roomService.changeSeat(a, room.id, 2);
      expect(moved.seats.find((s) => s.userId === a.id)).toMatchObject({ seat: 2, team: 0 });
      await expect(roomService.changeSeat(a, room.id, 0)).rejects.toMatchObject({ code: 'SEAT_TAKEN' });
      const solo = await roomService.createRoom(await createUser(), { uuid: randomUUID(), targetPoints: 15, bet: 0 });
      const soloHost = { id: solo.hostId, username: 'x' };
      await expect(roomService.changeSeat(soloHost, solo.id, 1)).rejects.toMatchObject({ code: 'SEAT_CHANGE_NOT_ALLOWED' });
    });

    it('salir libera el asiento; si sale el anfitrión sigue el próximo; si no queda nadie se cancela', async () => {
      const [host, a, b] = [await createUser(), await createUser(), await createUser()];
      const room = await create2v2(host);
      await roomService.joinRoom(a, room.id, { seat: 3 });
      await roomService.joinRoom(b, room.id, { seat: 1 });
      let r = await roomService.leaveRoom(b, room.id);
      expect(r.seats.map((s) => s.userId)).toEqual([host.id, a.id]);
      r = await roomService.leaveRoom(host, room.id);
      expect(r.hostId).toBe(a.id);
      expect(r.status).toBe('waiting');
      r = await roomService.leaveRoom(a, room.id);
      expect(r.status).toBe('cancelled');
      // Quedaron libres
      await expect(roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: 0 })).resolves.toBeTruthy();
    });

    it('sala privada 2 vs 2: se entra por código eligiendo asiento', async () => {
      const [host, friend] = [await createUser(), await createUser()];
      const room = await create2v2(host, { isPrivate: true });
      const joined = await roomService.joinRoomByCode(friend, room.code, { seat: 2 });
      expect(joined.seats.find((s) => s.userId === friend.id)).toMatchObject({ seat: 2, team: 0 });
    });
  });

  describe('apuestas', () => {
    it('al completarse se bloquean las 4 apuestas en una transacción', async () => {
      const { players, matchId } = await fullTable({ bet: 100 });
      for (const p of players) expect(await balanceOf(p.id)).toBe(900);
      const match = await Match.findById(matchId).lean();
      expect(match.config.mode).toBe('2v2');
      expect(match.players.map((p) => [p.seat, p.team, p.betLocked])).toEqual([[0, 0, 100], [1, 1, 100], [2, 0, 100], [3, 1, 100]]);
    });

    it('si a uno ya no le alcanza, no se bloquea ninguna y la sala sigue en espera con 3', async () => {
      const players = [];
      for (let i = 0; i < 4; i++) players.push(await createUser({ chips: true }));
      const admin = await createUser();
      const room = await create2v2(players[0], { bet: 500 });
      await roomService.joinRoom(players[1], room.id);
      await roomService.joinRoom(players[2], room.id);
      // El del asiento 1 se queda sin fichas antes de que entre el cuarto
      await adminAdjust({ adminId: admin.id, userId: players[1].id, amount: -800, reason: 'test', operationId: randomUUID() });
      await expect(roomService.joinRoom(players[3], room.id)).rejects.toMatchObject({ code: 'PLAYER_INSUFFICIENT_BALANCE' });
      const doc = await Room.findById(room.id).lean();
      expect(doc.status).toBe('waiting');
      expect(doc.seats).toHaveLength(3);
      expect(await Match.countDocuments()).toBe(0);
      for (const p of [players[0], players[2], players[3]]) expect(await balanceOf(p.id)).toBe(1000);
    });

    it('partida normal: cada ganador cobra 2 apuestas; las fichas se conservan', async () => {
      const { players, matchId } = await fullTable({ bet: 100 });
      const rt = await playToEnd(matchId, 7);
      const winners = rt.state.players.filter((p) => p.team === rt.state.winnerTeam).map((p) => p.id);
      await waitFor(async () => (await Match.findById(matchId).lean()).betsSettled);
      const balances = await Promise.all(players.map((p) => balanceOf(p.id)));
      players.forEach((p, i) => expect(balances[i]).toBe(winners.includes(p.id) ? 1100 : 900));
      expect(balances.reduce((a, b) => a + b, 0)).toBe(4000);
      for (const p of players) expect(await getLedgerSum(p.id)).toBe(await balanceOf(p.id));
      const match = await Match.findById(matchId).lean();
      expect(match.players.every((p) => p.result === (winners.includes(String(p.userId)) ? 'win' : 'loss'))).toBe(true);
      // Estadísticas del 2 vs 2 aparte; las de 1 vs 1 no se tocan
      const u = await User.findById(players[0].id).lean();
      expect(u.statsTwoVsTwo.played).toBe(1);
      expect(u.stats.played).toBe(0);
    });

    it('abandona uno: pierde su apuesta, su compañero la recupera y cada rival cobra 1,5', async () => {
      const { players, matchId } = await fullTable({ bet: 100 });
      const [a1, b1, a2, b2] = players;
      await matchService.abandonMatch(a1.id, matchId);
      await waitFor(async () => (await Match.findById(matchId).lean()).betsSettled);
      expect(await balanceOf(a1.id)).toBe(900);
      expect(await balanceOf(a2.id)).toBe(1000);
      expect(await balanceOf(b1.id)).toBe(1050);
      expect(await balanceOf(b2.id)).toBe(1050);
      const match = await Match.findById(matchId).lean();
      expect(Object.fromEntries(match.players.map((p) => [String(p.userId), p.result]))).toEqual({
        [a1.id]: 'abandon', [a2.id]: 'no-result', [b1.id]: 'win', [b2.id]: 'win'
      });
      const [ua1, ua2] = await Promise.all([User.findById(a1.id).lean(), User.findById(a2.id).lean()]);
      expect(ua1.statsTwoVsTwo).toMatchObject({ played: 1, lost: 1, abandoned: 1 });
      expect(ua2.statsTwoVsTwo).toMatchObject({ played: 0, lost: 0 });
      // Idempotente: liquidar de nuevo no mueve nada
      await settleMatchBets(matchId);
      expect(await balanceOf(b1.id)).toBe(1050);
      for (const p of players) expect(await getLedgerSum(p.id)).toBe(await balanceOf(p.id));
    });

    it('abandonan los dos de un equipo: cada rival cobra 2 apuestas', async () => {
      const { players, matchId, sockets } = await fullTable({ bet: 100 });
      const [a1, b1, a2, b2] = players;
      matchService.detachSocket(a2.id, sockets[a2.id].id); // el compañero se desconectó
      await matchService.abandonMatch(a1.id, matchId);
      await waitFor(async () => (await Match.findById(matchId).lean()).betsSettled);
      expect((await Match.findById(matchId).lean()).abandoners.map(String).sort()).toEqual([a1.id, a2.id].sort());
      expect(await balanceOf(a1.id)).toBe(900);
      expect(await balanceOf(a2.id)).toBe(900);
      expect(await balanceOf(b1.id)).toBe(1100);
      expect(await balanceOf(b2.id)).toBe(1100);
    });

    it('si se cancela antes de terminar (reinicio), se devuelve todo a los 4', async () => {
      const { players } = await fullTable({ bet: 100 });
      matchService.clearRuntimes();
      await matchService.recoverOnStartup();
      for (const p of players) expect(await balanceOf(p.id)).toBe(1000);
    });
  });

  describe('desconexión', () => {
    it('la pausa acumulada por desconexión tiene tope: superado, abandona', async () => {
      Object.assign(matchService.settings, { maxDisconnectPauseMs: 300, reconnectGraceMs: 10000 });
      const { players, matchId, sockets } = await fullTable({ bet: 0 });
      const [, b1] = players;
      matchService.detachSocket(b1.id, sockets[b1.id].id);
      await waitFor(() => matchService.getRuntime(matchId)?.finished);
      const match = await Match.findById(matchId).lean();
      expect(match.endReason).toBe('abandon');
      expect(String(match.abandonedBy)).toBe(b1.id);
    });

    it('en una partida completa, ningún socket recibe cartas en mano de otro jugador (ni del compañero)', async () => {
      const { matchId } = await fullTable({ bet: 0 });
      let rng = 11;
      const pick = (n) => { rng = (rng * 1103515245 + 12345) % 2147483648; return rng % n; };
      for (let i = 0; i < 3000; i++) {
        const rt = matchService.getRuntime(matchId);
        if (rt.finished) break;
        if (rt.finishing || rt.state.phase !== 'playing') { await new Promise((r) => setTimeout(r, 5)); continue; }
        // Verificación: lo último que recibió cada socket no tiene cartas en mano de los otros tres
        const hands = rt.state.hand.cards;
        for (const p of rt.players) {
          const last = emissions.filter((e) => e.event === 'game:state' && e.target === `s-${p.id}`).at(-1);
          if (!last) continue;
          const json = JSON.stringify(last.data);
          for (const [otherId, cards] of Object.entries(hands)) {
            if (otherId === p.id) continue;
            for (const card of cards) expect(json).not.toContain(`"${card}"`);
          }
        }
        const actor = rt.state.players.find((p) => getAvailableActions(rt.state, p.id).length > 0);
        const types = getAvailableActions(rt.state, actor.id).filter((t) => t !== 'GO_TO_DECK' || pick(8) === 0);
        const type = types[pick(types.length)] || 'GO_TO_DECK';
        const payload = type === 'PLAY_CARD' ? { cardId: rt.state.hand.cards[actor.id][0] } : {};
        await matchService.handleAction(actor.id, { matchId, actionId: randomUUID(), type, payload });
      }
      expect(matchService.getRuntime(matchId).finished).toBe(true);
    });
  });

  describe('señas', () => {
    it('la seña llega solo al compañero; los rivales nunca la reciben', async () => {
      const { players, matchId } = await fullTable({ bet: 0 });
      const [a1, b1, a2, b2] = players;
      emissions.length = 0;
      matchService.sendSign(a1.id, { matchId, sign: 'ANCHO_ESPADA' });
      const signs = emissions.filter((e) => e.event === 'game:sign');
      expect(signs).toEqual([{ target: `s-${a2.id}`, event: 'game:sign', data: expect.objectContaining({ from: a1.id, sign: 'ANCHO_ESPADA' }) }]);
      // Al reconectar, el compañero recupera las señas de la mano; los rivales y el que la hizo no
      const rt = matchService.getRuntime(matchId);
      expect(matchService.buildStateFor(rt, a2.id).signs).toEqual([expect.objectContaining({ from: a1.id, sign: 'ANCHO_ESPADA' })]);
      for (const p of [a1, b1, b2]) expect(matchService.buildStateFor(rt, p.id).signs).toEqual([]);
    });

    it('una seña cada 2 s, solo de la lista y solo en 2 vs 2', async () => {
      const { players, matchId } = await fullTable({ bet: 0 });
      const [, b1] = players;
      matchService.sendSign(b1.id, { matchId, sign: 'UN_TRES' });
      expect(() => matchService.sendSign(b1.id, { matchId, sign: 'UN_DOS' })).toThrow(expect.objectContaining({ code: 'SIGN_RATE_LIMITED' }));
      expect(() => matchService.sendSign(players[0].id, { matchId, sign: 'CUALQUIERA' })).toThrow(expect.objectContaining({ code: 'INVALID_SIGN' }));

      const host = await createUser();
      const guest = await createUser();
      const solo = await roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: 0 });
      const { matchId: soloMatch } = await roomService.joinRoom(guest, solo.id);
      expect(() => matchService.sendSign(host.id, { matchId: soloMatch, sign: 'UN_TRES' })).toThrow(expect.objectContaining({ code: 'SIGNS_NOT_AVAILABLE' }));
    });

    it('en una partida completa con señas, ningún rival recibe una y quedan en el registro de la mano', async () => {
      const { players, matchId } = await fullTable({ bet: 0 });
      const teamOf = Object.fromEntries(players.map((p, seat) => [p.id, seat % 2]));
      let rng = 5;
      const pick = (n) => { rng = (rng * 1103515245 + 12345) % 2147483648; return rng % n; };
      const SIGNS = matchService.SIGNS;
      for (let i = 0; i < 3000; i++) {
        const rt = matchService.getRuntime(matchId);
        if (rt.finished) break;
        if (rt.finishing || rt.state.phase !== 'playing') { await new Promise((r) => setTimeout(r, 5)); continue; }
        // Cada tanto, alguien hace una seña (se ignora el límite de 2 s reiniciando su marca)
        if (pick(3) === 0) {
          const signer = players[pick(4)];
          rt.lastSignAt.delete(signer.id);
          matchService.sendSign(signer.id, { matchId, sign: SIGNS[pick(SIGNS.length)] });
        }
        const actor = rt.state.players.find((p) => getAvailableActions(rt.state, p.id).length > 0);
        const types = getAvailableActions(rt.state, actor.id).filter((t) => t !== 'GO_TO_DECK' || pick(8) === 0);
        const type = types[pick(types.length)] || 'GO_TO_DECK';
        const payload = type === 'PLAY_CARD' ? { cardId: rt.state.hand.cards[actor.id][0] } : {};
        await matchService.handleAction(actor.id, { matchId, actionId: randomUUID(), type, payload });
      }
      const signEvents = emissions.filter((e) => e.event === 'game:sign');
      expect(signEvents.length).toBeGreaterThan(0);
      for (const e of signEvents) {
        const receiver = e.target.replace('s-', '');
        expect(teamOf[receiver]).toBe(teamOf[e.data.from]);
        expect(receiver).not.toBe(e.data.from);
      }
      // Los game:state tampoco llevan señas de otros equipos
      for (const e of emissions.filter((x) => x.event === 'game:state')) {
        for (const s of e.data.signs || []) expect(teamOf[s.from]).toBe(teamOf[e.data.me.id]);
      }
      const logs = await MatchHandLog.find({ matchId }).lean();
      expect(logs.flatMap((l) => l.signs).length).toBe(signEvents.length);
    });
  });

  describe('revancha 2 vs 2', () => {
    it('arranca recién cuando aceptan los 4, con los mismos asientos y la apuesta bloqueada otra vez', async () => {
      const { players, matchId } = await fullTable({ bet: 100 });
      await playToEnd(matchId, 9);
      for (const p of players.slice(0, 3)) {
        const r = await rematchService.requestRematch(p.id, matchId);
        expect(r.state).toBe('requested');
      }
      const last = emissions.filter((e) => e.event === 'game:rematch').at(-1).data;
      expect(last.accepted).toHaveLength(3);
      const started = await rematchService.requestRematch(players[3].id, matchId);
      expect(started.state).toBe('started');
      const room = await Room.findById(started.roomId).lean();
      expect(room.config).toMatchObject({ mode: '2v2', maxPlayers: 4, bet: 100 });
      expect(room.seats.map((s) => [String(s.userId), s.seat])).toEqual(players.map((p, seat) => [p.id, seat]));
      const match = await Match.findById(room.matchId).lean();
      expect(match.players.every((p) => p.betLocked === 100)).toBe(true);
    });

    it('con un rechazo se cancela para todos', async () => {
      const { players, matchId } = await fullTable({ bet: 0 });
      await playToEnd(matchId, 4);
      await rematchService.requestRematch(players[0].id, matchId);
      rematchService.declineRematch(players[2].id, matchId);
      expect(emissions.filter((e) => e.event === 'game:rematch').at(-1).data).toMatchObject({ state: 'declined', by: players[2].id });
      await expect(rematchService.requestRematch(players[1].id, matchId)).rejects.toMatchObject({ code: 'REMATCH_UNAVAILABLE' });
    });
  });

  describe('historial, ranking y reportes', () => {
    it('el historial muestra modo, compañero y rivales; el detalle no revela cartas ajenas', async () => {
      const { players, matchId } = await fullTable({ bet: 100 });
      const [a1, b1, a2, b2] = players;
      await matchService.abandonMatch(b1.id, matchId);
      await waitFor(async () => (await Match.findById(matchId).lean()).betsSettled);

      const { items } = await historyService.listMyMatches(b2.id, { skip: 0, limit: 10 });
      expect(items[0]).toMatchObject({
        config: { mode: '2v2', bet: 100 }, result: 'no-result', partner: { id: b1.id }, chipsNet: 0
      });
      expect(items[0].rivals.map((r) => r.id).sort()).toEqual([a1.id, a2.id].sort());
      const winner = (await historyService.listMyMatches(a1.id, { skip: 0, limit: 10 })).items[0];
      expect(winner).toMatchObject({ result: 'won', partner: { id: a2.id }, chipsNet: 50 });

      const detail = await historyService.getMatchDetail(a1.id, matchId);
      const logs = await MatchHandLog.find({ matchId }).lean();
      const json = JSON.stringify(detail);
      for (const log of logs) {
        for (const [owner, cards] of Object.entries(log.dealt)) {
          if (owner === a1.id) continue;
          const played = new Set(log.events.filter((e) => e.action === 'PLAY_CARD').map((e) => e.payload.cardId));
          for (const card of cards) if (!played.has(card)) expect(json).not.toContain(`"${card}"`);
        }
      }
      expect(json).not.toContain('"signs"');
    });

    it('el ranking separa 1 vs 1 y 2 vs 2 (también por período)', async () => {
      const { matchId } = await fullTable({ bet: 100 });
      const rt = await playToEnd(matchId, 21);
      await waitFor(async () => (await Match.findById(matchId).lean()).status === 'finished');
      const winners = rt.state.players.filter((p) => p.team === rt.state.winnerTeam).map((p) => p.id).sort();

      for (const period of ['all', 'week']) {
        const twoVsTwo = await getRanking({ by: 'won', period, mode: '2v2' }, { skip: 0, limit: 10 });
        expect(twoVsTwo.items.filter((r) => r.won > 0).map((r) => r.userId).sort()).toEqual(winners);
        const oneVsOne = await getRanking({ by: 'won', period, mode: '1v1' }, { skip: 0, limit: 10 });
        expect(oneVsOne.items).toEqual([]);
      }
    });

    it('el reporte de flujos de fichas contempla las privadas 2 vs 2', async () => {
      const players = [];
      for (let i = 0; i < 4; i++) players.push(await createUser({ chips: true }));
      for (let n = 0; n < 3; n++) {
        const room = await create2v2(players[0], { bet: 100, isPrivate: true });
        for (const [i, p] of players.slice(1).entries()) await roomService.joinRoomByCode(p, room.code, { seat: i + 1 });
        const doc = await Room.findById(room.id).lean();
        for (const p of players) await matchService.attachSocket(String(doc.matchId), p.id, fakeSocket(`s-${p.id}-${n}`));
        // Siempre abandona el del asiento 1 (pareja B): la pareja A gana
        await matchService.abandonMatch(players[1].id, String(doc.matchId));
        await waitFor(async () => (await Match.findById(doc.matchId).lean()).betsSettled);
      }
      const flows = await adminService.chipFlows({ days: 30, minMatches: 3 });
      const pair = flows.find((f) => f.giver.id === players[1].id && f.receiver.id === players[0].id);
      expect(pair).toMatchObject({ matches: 3, giverWins: 0, oneDirection: true });
    });
  });
});
