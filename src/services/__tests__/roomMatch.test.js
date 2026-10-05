import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LedgerEntry } from '../../models/LedgerEntry.js';
import { Match } from '../../models/Match.js';
import { MatchHandLog } from '../../models/MatchHandLog.js';
import { Room } from '../../models/Room.js';
import { User } from '../../models/User.js';
import { setTestSink } from '../../sockets/emitter.js';
import { computePayouts } from '../betService.js';
import * as matchService from '../matchService.js';
import * as roomService from '../roomService.js';
import { getLedgerSum } from '../walletService.js';
import { connectTestDb, disconnectTestDb, hasTestDb, resetTestDb } from './setupDb.js';
import {
  createUser, fakeSocket, playToEnd, sleep, startTable, waitFor
} from './tableHelpers.js';

const DEFAULT_SETTINGS = { ...matchService.settings };
const balanceOf = async (userId) => (await User.findById(userId).lean()).balance;

describe.skipIf(!hasTestDb)('salas y partidas (integración)', () => {
  let emissions;

  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    await resetTestDb();
    Object.assign(matchService.settings, DEFAULT_SETTINGS, { nextHandDelayMs: 0 });
    emissions = [];
    setTestSink((e) => emissions.push(e));
  });
  afterEach(() => {
    setTestSink(null);
    matchService.clearRuntimes();
  });

  describe('salas', () => {
    it('crear es idempotente por uuid y aparece en el lobby', async () => {
      const host = await createUser();
      const uuid = randomUUID();
      const a = await roomService.createRoom(host, { uuid, targetPoints: 15, bet: 0 });
      const b = await roomService.createRoom(host, { uuid, targetPoints: 15, bet: 0 });
      expect(b.id).toBe(a.id);
      expect(a.code).toMatch(/^[A-Z2-9]{6}$/);
      expect(await Room.countDocuments()).toBe(1);
      expect(emissions.find((e) => e.event === 'lobby:rooms').data.map((r) => r.id)).toEqual([a.id]);
    });

    it('una sola sala activa por usuario', async () => {
      const host = await createUser();
      await roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: 0 });
      await expect(roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 30, bet: 0 }))
        .rejects.toMatchObject({ code: 'ALREADY_IN_ROOM' });
    });

    it('unirse arranca la partida; nadie más puede entrar', async () => {
      const [host, guest, third] = [await createUser(), await createUser(), await createUser()];
      const room = await roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: 0 });

      await expect(roomService.joinRoom(host, room.id)).rejects.toMatchObject({ code: 'CANNOT_JOIN_OWN_ROOM' });
      const joined = await roomService.joinRoom(guest, room.id);
      expect(joined.status).toBe('playing');
      expect(joined.seats.map((s) => s.userId)).toEqual([host.id, guest.id]);

      const match = await Match.findById(joined.matchId).lean();
      expect(match.status).toBe('playing');
      expect(match.players.map((p) => p.team)).toEqual([0, 1]);
      expect(matchService.getRuntime(joined.matchId).state.phase).toBe('playing');

      await expect(roomService.joinRoom(third, room.id)).rejects.toMatchObject({ code: 'ROOM_NOT_AVAILABLE' });
      await expect(roomService.cancelRoom(host, room.id)).rejects.toMatchObject({ code: 'ROOM_NOT_CANCELLABLE' });
      const updates = emissions.filter((e) => e.event === 'room:update').map((e) => e.target);
      expect(updates).toEqual(expect.arrayContaining([`user:${host.id}`, `user:${guest.id}`]));
    });

    it('con dos que se unen a la vez, entra uno solo', async () => {
      const [host, g1, g2] = [await createUser(), await createUser(), await createUser()];
      const room = await roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: 0 });
      const results = await Promise.allSettled([roomService.joinRoom(g1, room.id), roomService.joinRoom(g2, room.id)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected').reason.code).toBe('ROOM_NOT_AVAILABLE');
      expect(await Match.countDocuments()).toBe(1);
    });

    it('el anfitrión puede cancelar su sala en espera', async () => {
      const host = await createUser();
      const room = await roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: 0 });
      expect((await roomService.cancelRoom(host, room.id)).status).toBe('cancelled');
      expect(await roomService.getActiveRoom(host.id)).toBeNull();
    });
  });

  describe('salas privadas', () => {
    const createPrivate = (host, bet = 0) => roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet, isPrivate: true });

    it('no aparece en el lobby ni en la lista, y no se ofrece por socket', async () => {
      const host = await createUser();
      const other = await createUser();
      const publicRoom = await roomService.createRoom(other, { uuid: randomUUID(), targetPoints: 15, bet: 0 });
      const priv = await createPrivate(host);
      expect(priv.config.isPrivate).toBe(true);
      expect(priv.status).toBe('waiting');

      expect((await roomService.listLobbyRooms()).map((r) => r.id)).toEqual([publicRoom.id]);
      const { items, total } = await roomService.listOpenRooms({}, { skip: 0, limit: 50 });
      expect(items.map((r) => r.id)).toEqual([publicRoom.id]);
      expect(total).toBe(1);
      // Crearla no avisa al lobby
      expect(emissions.filter((e) => e.event === 'lobby:rooms').every((e) => e.data.every((r) => r.id !== priv.id))).toBe(true);
      // El anfitrión sí la ve como su sala activa (para volver a la mesa)
      expect((await roomService.getActiveRoom(host.id)).id).toBe(priv.id);
    });

    it('conocer el id no alcanza: solo se entra con el código', async () => {
      const [host, guest] = [await createUser(), await createUser()];
      const priv = await createPrivate(host);
      await expect(roomService.joinRoom(guest, priv.id)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect((await Room.findById(priv.id)).status).toBe('waiting');
    });

    it('con el código se entra (sin importar mayúsculas) y arranca la partida', async () => {
      const [host, guest] = [await createUser(), await createUser()];
      const priv = await createPrivate(host);
      expect((await roomService.getRoomByCode(priv.code)).id).toBe(priv.id);

      const joined = await roomService.joinRoomByCode(guest, priv.code);
      expect(joined).toMatchObject({ id: priv.id, status: 'playing' });
      expect(matchService.getRuntime(joined.matchId)).toBeTruthy();
    });

    it('un código inexistente, o de una sala que ya empezó, responde 404', async () => {
      const [host, guest, third] = [await createUser(), await createUser(), await createUser()];
      await expect(roomService.getRoomByCode('ZZZZZZ')).rejects.toMatchObject({ code: 'ROOM_CODE_NOT_FOUND', status: 404 });
      await expect(roomService.joinRoomByCode(guest, 'ZZZZZZ')).rejects.toMatchObject({ code: 'ROOM_CODE_NOT_FOUND' });

      const priv = await createPrivate(host);
      await roomService.joinRoomByCode(guest, priv.code);
      await expect(roomService.joinRoomByCode(third, priv.code)).rejects.toMatchObject({ code: 'ROOM_CODE_NOT_FOUND' });
      await expect(roomService.getRoomByCode(priv.code)).rejects.toMatchObject({ code: 'ROOM_CODE_NOT_FOUND' });
    });

    it('no podés unirte a tu propia sala con el código', async () => {
      const host = await createUser();
      const priv = await createPrivate(host);
      await expect(roomService.joinRoomByCode(host, priv.code)).rejects.toMatchObject({ code: 'CANNOT_JOIN_OWN_ROOM' });
    });

    it('con apuesta: el monto escrito se bloquea a los dos al entrar, y sin saldo no entra', async () => {
      const [host, guest, poor] = [await createUser({ chips: true }), await createUser({ chips: true }), await createUser()];
      const priv = await createPrivate(host, 130); // un monto cualquiera, no de a 500
      expect(priv.config.bet).toBe(130);

      await expect(roomService.joinRoomByCode(poor, priv.code)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
      expect((await Room.findById(priv.id)).status).toBe('waiting');

      await roomService.joinRoomByCode(guest, priv.code);
      expect(await balanceOf(host.id)).toBe(870);
      expect(await balanceOf(guest.id)).toBe(870);
      expect(await LedgerEntry.countDocuments({ type: 'BET_LOCK' })).toBe(2);
    });

    it('el anfitrión puede cancelarla y su código deja de servir', async () => {
      const host = await createUser();
      const priv = await createPrivate(host);
      const cancelled = await roomService.cancelRoom(host, priv.id);
      expect(cancelled.status).toBe('cancelled');
      await expect(roomService.joinRoomByCode(await createUser(), priv.code)).rejects.toMatchObject({ code: 'ROOM_CODE_NOT_FOUND' });
    });
  });

  describe('apuestas', () => {
    it('crear con apuesta verifica el saldo sin bloquear', async () => {
      const poor = await createUser();
      await expect(roomService.createRoom(poor, { uuid: randomUUID(), targetPoints: 15, bet: 100 }))
        .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });

      const host = await createUser({ chips: true });
      await roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: 300 });
      expect(await balanceOf(host.id)).toBe(1000);
    });

    it('si el que se une no tiene saldo, no se bloquea nada y la sala sigue esperando', async () => {
      const host = await createUser({ chips: true });
      const poor = await createUser();
      const room = await roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: 300 });
      await expect(roomService.joinRoom(poor, room.id)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
      expect((await Room.findById(room.id).lean()).status).toBe('waiting');
      expect(await LedgerEntry.countDocuments({ type: 'BET_LOCK' })).toBe(0);
      expect(await Match.countDocuments()).toBe(0);
    });

    it('al empezar se bloquean ambas apuestas y al terminar el ganador cobra el pozo', async () => {
      const { host, guest, matchId } = await startTable({ bet: 300 });
      expect(await balanceOf(host.id)).toBe(700);
      expect(await balanceOf(guest.id)).toBe(700);
      expect(emissions.filter((e) => e.event === 'wallet:update')).toHaveLength(2);

      await playToEnd(matchId);
      const match = await Match.findById(matchId).lean();
      const winnerId = String(match.players.find((p) => p.team === match.winnerTeam).userId);
      const loserId = winnerId === host.id ? guest.id : host.id;

      expect(match.betsSettled).toBe(true);
      expect(await balanceOf(winnerId)).toBe(1300);
      expect(await balanceOf(loserId)).toBe(700);
      for (const id of [winnerId, loserId]) expect(await getLedgerSum(id)).toBe(await balanceOf(id));
      expect((await User.findById(winnerId).lean()).stats.chipsWon).toBe(300);

      const finished = emissions.find((e) => e.event === 'game:finished');
      expect(finished.data.chips).toMatchObject({ bet: 300, pot: 600 });
      expect(finished.data.chips.players.find((p) => p.userId === winnerId)).toMatchObject({ received: 600, net: 300 });
      expect(finished.data.chips.players.find((p) => p.userId === loserId)).toMatchObject({ received: 0, net: -300 });
    }, 60000);

    it('la comisión de la casa se descuenta del pozo', () => {
      const players = [{ userId: 'a', team: 0, betLocked: 500 }, { userId: 'b', team: 1, betLocked: 500 }];
      expect(computePayouts({ players, winnerTeam: 1 }, 0)).toEqual([{ userId: 'b', amount: 1000 }]);
      expect(computePayouts({ players, winnerTeam: 1 }, 0.05)).toEqual([{ userId: 'b', amount: 950 }]);
    });

    it('al reiniciar, las partidas en juego se cancelan y se devuelven las apuestas', async () => {
      const { host, guest, room, matchId } = await startTable({ bet: 250 });
      matchService.clearRuntimes();

      expect(await matchService.recoverOnStartup()).toEqual({ cancelled: 1, settled: 1 });
      expect((await Match.findById(matchId).lean())).toMatchObject({ status: 'cancelled', betsSettled: true });
      expect((await Room.findById(room.id).lean()).status).toBe('cancelled');
      expect(await balanceOf(host.id)).toBe(1000);
      expect(await balanceOf(guest.id)).toBe(1000);
      expect(await LedgerEntry.countDocuments({ type: 'BET_REFUND' })).toBe(2);
      // Repetir no devuelve dos veces
      await matchService.recoverOnStartup();
      expect(await balanceOf(host.id)).toBe(1000);
    });
  });

  describe('abandono, desconexión y tiempos', () => {
    it('abandonar es derrota: el rival cobra y queda registrado', async () => {
      const { host, guest, matchId } = await startTable({ bet: 200 });
      await matchService.abandonMatch(host.id, matchId);

      const match = await Match.findById(matchId).lean();
      expect(match).toMatchObject({ status: 'finished', endReason: 'abandon', winnerTeam: 1 });
      expect(String(match.abandonedBy)).toBe(host.id);
      expect(await balanceOf(guest.id)).toBe(1200);
      expect(await balanceOf(host.id)).toBe(800);
      expect((await User.findById(host.id).lean()).stats).toMatchObject({ played: 1, lost: 1, abandoned: 1 });
      await expect(matchService.abandonMatch(guest.id, matchId)).rejects.toMatchObject({ code: 'MATCH_NOT_ACTIVE' });
    });

    it('si no vuelve dentro de la gracia, pierde por abandono', async () => {
      matchService.settings.reconnectGraceMs = 80;
      const { host, guest, matchId, sockets } = await startTable();

      matchService.detachSocket(guest.id, sockets[guest.id].id);
      expect(emissions).toContainEqual(expect.objectContaining({
        event: 'player:disconnected', data: { playerId: guest.id, graceSeconds: 0 }
      }));
      await waitFor(() => matchService.getRuntime(matchId).finished);
      const match = await Match.findById(matchId).lean();
      expect(match).toMatchObject({ endReason: 'abandon', winnerTeam: 0 });
      expect(String(match.abandonedBy)).toBe(guest.id);
      expect(host.id).toBeTruthy();
    });

    it('si vuelve a tiempo, sigue la partida y el rival recibe el aviso', async () => {
      matchService.settings.reconnectGraceMs = 200;
      const { guest, matchId, sockets } = await startTable();
      matchService.detachSocket(guest.id, sockets[guest.id].id);
      const viewWhileAway = matchService.buildStateFor(matchService.getRuntime(matchId), guest.id);
      expect(viewWhileAway.disconnected[guest.id].remainingMs).toBeGreaterThan(0);

      await matchService.attachSocket(matchId, guest.id, fakeSocket('vuelve'));
      expect(emissions).toContainEqual(expect.objectContaining({ event: 'player:reconnected', data: { playerId: guest.id } }));
      await sleep(300);
      expect(matchService.getRuntime(matchId).finished).toBe(false);
    });

    it('vence el tiempo de turno: se resuelve solo y sigue el juego', async () => {
      matchService.settings.turnTimeoutMs = 60;
      const { matchId } = await startTable();
      const rt = matchService.getRuntime(matchId);
      expect(matchService.buildStateFor(rt, rt.players[0].id).turn.remainingMs).toBeGreaterThan(0);

      await waitFor(() => rt.state.score.some((s) => s > 0));
      expect(emissions).toContainEqual(expect.objectContaining({
        event: 'game:event', data: expect.objectContaining({ type: 'TURN_TIMEOUT' })
      }));
    });

    it('el turno no corre mientras quien debe jugar está desconectado', async () => {
      matchService.settings.turnTimeoutMs = 40;
      matchService.settings.reconnectGraceMs = 10000;
      const { matchId, sockets } = await startTable();
      const rt = matchService.getRuntime(matchId);
      const actor = rt.state.players[rt.state.hand.turnSeat].id;

      matchService.detachSocket(actor, sockets[actor].id);
      expect(rt.turn).toBeNull();
      await sleep(120);
      expect(rt.state.score).toEqual([0, 0]);
    });

    it('volver al lobby y regresar a la mesa NO reinicia el reloj del turno', async () => {
      matchService.settings.turnTimeoutMs = 600;
      const { matchId, sockets } = await startTable();
      const rt = matchService.getRuntime(matchId);
      const actor = rt.state.players[rt.state.hand.turnSeat].id;
      const deadline = rt.turn.deadline;
      const timer = rt.turn.timer;

      // El jugador sale de la mesa y vuelve varias veces (el socket sigue conectado: entra con otro id)
      for (let i = 0; i < 3; i++) {
        await sleep(60);
        await matchService.attachSocket(matchId, actor, fakeSocket(`${sockets[actor].id}-vuelta-${i}`));
      }
      expect(rt.turn.deadline).toBe(deadline);
      expect(rt.turn.timer).toBe(timer);
      const remaining = matchService.buildStateFor(rt, actor).turn.remainingMs;
      expect(remaining).toBeLessThan(500); // pasó el tiempo de las idas y vueltas, no se regaló

      // Y el tiempo igual vence
      await waitFor(() => rt.state.score.some((s) => s > 0));
      expect(emissions).toContainEqual(expect.objectContaining({
        event: 'game:event', data: expect.objectContaining({ type: 'TURN_TIMEOUT' })
      }));
    });

    it('si se desconecta y vuelve, retoma el tiempo que le quedaba (no uno nuevo)', async () => {
      matchService.settings.turnTimeoutMs = 1000;
      matchService.settings.reconnectGraceMs = 10000;
      const { matchId, sockets } = await startTable();
      const rt = matchService.getRuntime(matchId);
      const actor = rt.state.players[rt.state.hand.turnSeat].id;

      await sleep(300);
      matchService.detachSocket(actor, sockets[actor].id);
      expect(rt.turn).toBeNull();
      expect(rt.turnRemainingMs).toBeLessThan(800);
      await sleep(300); // desconectado: el reloj no corre

      await matchService.attachSocket(matchId, actor, fakeSocket('vuelve'));
      expect(rt.turn).not.toBeNull();
      const remaining = matchService.buildStateFor(rt, actor).turn.remainingMs;
      expect(remaining).toBeGreaterThan(300);
      expect(remaining).toBeLessThan(800); // lo que quedaba (~700 ms), no 1000
    });

    it('una jugada nueva sí reinicia el reloj completo', async () => {
      matchService.settings.turnTimeoutMs = 600;
      const { matchId } = await startTable();
      const rt = matchService.getRuntime(matchId);
      const actor = rt.state.players[rt.state.hand.turnSeat].id;
      await sleep(250);
      const before = rt.turn.deadline;

      await matchService.handleAction(actor, {
        matchId, actionId: randomUUID(), type: 'PLAY_CARD', payload: { cardId: rt.state.hand.cards[actor][0] }
      });
      expect(rt.turn.deadline).toBeGreaterThan(before + 200);
      expect(rt.turn.playerIds).not.toContain(actor);
    });
  });

  describe('partida completa', () => {
    it('se juega hasta el final sin filtrar cartas, y queda registrada', async () => {
      const [host, guest] = [await createUser(), await createUser()];
      const room = await roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: 0 });
      const { matchId } = await roomService.joinRoom(guest, room.id);
      const socketOwner = { 's-host': host.id, 's-guest': guest.id };

      // Cada emisión se revisa en el momento: no puede contener cartas que el destinatario no debe ver
      const leaks = [];
      setTestSink((e) => {
        emissions.push(e);
        const rt = matchService.getRuntime(matchId);
        if (!rt?.state.hand) return;
        const json = JSON.stringify(e.data);
        const hiddenFor = (userId) => rt.state.players
          .filter((p) => p.id !== userId)
          .flatMap((p) => rt.state.hand.cards[p.id]);
        const forbidden = socketOwner[e.target] ? hiddenFor(socketOwner[e.target]) : Object.values(rt.state.hand.cards).flat();
        for (const card of forbidden) if (json.includes(`"${card}"`)) leaks.push({ event: e.event, card });
      });

      const hostSocket = fakeSocket('s-host');
      await matchService.attachSocket(matchId, host.id, hostSocket);
      await matchService.attachSocket(matchId, guest.id, fakeSocket('s-guest'));
      const firstState = emissions.find((e) => e.target === 's-host' && e.event === 'game:state');
      expect(firstState.data.hand.myCards).toHaveLength(3);

      await playToEnd(matchId);
      expect(leaks).toEqual([]);

      const match = await Match.findById(matchId).lean();
      expect(match.status).toBe('finished');
      expect(match.endReason).toBe('normal');
      expect(Math.max(...match.score)).toBe(15);
      expect(await MatchHandLog.countDocuments({ matchId })).toBe(match.handsPlayed);
      expect((await Room.findById(room.id).lean()).status).toBe('finished');

      const winnerId = match.players.find((p) => p.team === match.winnerTeam).userId;
      const [winner, loser] = await Promise.all([
        User.findById(winnerId).lean(),
        User.findOne({ _id: { $in: [host.id, guest.id], $ne: winnerId } }).lean()
      ]);
      expect(winner.stats).toMatchObject({ played: 1, won: 1, lost: 0 });
      expect(loser.stats).toMatchObject({ played: 1, won: 0, lost: 1 });
      expect(emissions.some((e) => e.event === 'game:finished' && e.target === `match:${matchId}`)).toBe(true);
    }, 120000);

    it('ignora acciones repetidas y rechaza a quien no juega', async () => {
      const outsider = await createUser();
      const { matchId } = await startTable();
      const rt = matchService.getRuntime(matchId);
      const mano = rt.state.players[rt.state.hand.manoSeat].id;
      const actionId = randomUUID();

      await matchService.handleAction(mano, { matchId, actionId, type: 'CALL_TRUCO', payload: {} });
      const again = await matchService.handleAction(mano, { matchId, actionId, type: 'CALL_TRUCO', payload: {} });
      expect(again.duplicated).toBe(true);
      await expect(matchService.handleAction(outsider.id, { matchId, actionId: randomUUID(), type: 'ACCEPT' }))
        .rejects.toMatchObject({ code: 'NOT_A_PLAYER' });
      await expect(matchService.handleAction(mano, { matchId, actionId: randomUUID(), type: 'ACCEPT' }))
        .rejects.toMatchObject({ code: 'NOTHING_TO_ANSWER' });
    });

    it('una nueva conexión del mismo jugador reemplaza a la anterior', async () => {
      const { host, matchId, sockets } = await startTable();
      await matchService.attachSocket(matchId, host.id, fakeSocket('tab-2'));
      expect(emissions).toContainEqual(expect.objectContaining({
        target: sockets[host.id].id, event: 'game:error', data: expect.objectContaining({ code: 'SESSION_REPLACED' })
      }));
    });
  });
});
