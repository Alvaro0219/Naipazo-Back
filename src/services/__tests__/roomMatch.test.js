import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAvailableActions } from '../../game/truco/index.js';
import { Match } from '../../models/Match.js';
import { MatchHandLog } from '../../models/MatchHandLog.js';
import { Room } from '../../models/Room.js';
import { User } from '../../models/User.js';
import { setTestSink } from '../../sockets/emitter.js';
import * as matchService from '../matchService.js';
import * as roomService from '../roomService.js';
import { connectTestDb, disconnectTestDb, hasTestDb, resetTestDb } from './setupDb.js';

let seq = 0;
async function createUser() {
  seq += 1;
  const doc = await User.create({
    username: `mesa${seq}`, email: `mesa${seq}@test.com`, passwordHash: 'x', acceptedTermsAt: new Date()
  });
  return { id: String(doc._id), username: doc.username };
}

/** Socket falso: guarda lo que se le emite directamente. */
function fakeSocket(id) {
  return { id, emitted: [], joined: [], emit(event, data) { this.emitted.push({ event, data }); }, join(room) { this.joined.push(room); } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasTestDb)('salas y partidas (integración)', () => {
  let emissions;

  beforeAll(async () => {
    await connectTestDb();
    matchService.settings.nextHandDelayMs = 0;
  });
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    await resetTestDb();
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

    it('no permite apuestas todavía ni dos salas activas por usuario', async () => {
      const host = await createUser();
      await expect(roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: 100 }))
        .rejects.toMatchObject({ code: 'BETS_NOT_AVAILABLE' });
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
      // Ambos jugadores reciben room:update
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

  describe('partida completa', () => {
    it('se juega hasta el final sin filtrar cartas, y queda registrada', async () => {
      const [host, guest] = [await createUser(), await createUser()];
      const room = await roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: 0 });
      const { matchId } = await roomService.joinRoom(guest, room.id);
      const sockets = { [host.id]: fakeSocket('s-host'), [guest.id]: fakeSocket('s-guest') };
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

      await matchService.attachSocket(matchId, host.id, sockets[host.id]);
      await matchService.attachSocket(matchId, guest.id, sockets[guest.id]);
      expect(sockets[host.id].emitted[0].event).toBe('game:state');
      expect(sockets[host.id].emitted[0].data.hand.myCards).toHaveLength(3);

      let rng = 12345;
      const pick = (n) => { rng = (rng * 1103515245 + 12345) % 2147483648; return rng % n; };
      for (let i = 0; i < 2000; i++) {
        const rt = matchService.getRuntime(matchId);
        if (rt.finished) break;
        if (rt.state.phase !== 'playing') { await sleep(5); continue; }
        const actor = rt.state.players.find((p) => getAvailableActions(rt.state, p.id).length > 0);
        const types = getAvailableActions(rt.state, actor.id).filter((t) => t !== 'GO_TO_DECK' || pick(8) === 0);
        const type = types[pick(types.length)] || 'GO_TO_DECK';
        const payload = type === 'PLAY_CARD' ? { cardId: rt.state.hand.cards[actor.id][0] } : {};
        await matchService.handleAction(actor.id, { matchId, actionId: randomUUID(), type, payload });
      }

      const rt = matchService.getRuntime(matchId);
      expect(rt.finished).toBe(true);
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
      const [host, guest, outsider] = [await createUser(), await createUser(), await createUser()];
      const room = await roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: 0 });
      const { matchId } = await roomService.joinRoom(guest, room.id);
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
      const [host, guest] = [await createUser(), await createUser()];
      const room = await roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: 0 });
      const { matchId } = await roomService.joinRoom(guest, room.id);

      await matchService.attachSocket(matchId, host.id, fakeSocket('tab-1'));
      await matchService.attachSocket(matchId, host.id, fakeSocket('tab-2'));
      expect(emissions).toContainEqual(expect.objectContaining({
        target: 'tab-1', event: 'game:error', data: expect.objectContaining({ code: 'SESSION_REPLACED' })
      }));

      matchService.detachSocket(host.id, 'tab-2');
      expect(emissions).toContainEqual(expect.objectContaining({ event: 'player:disconnected', data: { playerId: host.id, graceSeconds: null } }));
      await matchService.attachSocket(matchId, host.id, fakeSocket('tab-3'));
      expect(emissions).toContainEqual(expect.objectContaining({ event: 'player:reconnected', data: { playerId: host.id } }));
    });

    it('al reiniciar, las partidas en juego se cancelan', async () => {
      const [host, guest] = [await createUser(), await createUser()];
      const room = await roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: 0 });
      const { matchId } = await roomService.joinRoom(guest, room.id);
      matchService.clearRuntimes();

      expect(await matchService.cancelInterruptedMatches()).toBe(1);
      expect((await Match.findById(matchId).lean()).status).toBe('cancelled');
      expect((await Room.findById(room.id).lean()).status).toBe('cancelled');
      expect(await roomService.getActiveRoom(host.id)).toBeNull();
    });
  });
});
