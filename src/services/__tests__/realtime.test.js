// Concurrencia y tiempo real con sockets REALES (EXACTITUD_DEL_JUEGO.md, sección 7): un servidor Socket.IO
// de verdad y un cliente socket.io-client por jugador. El caso 8 (reinicio del servidor) está en roomMatch.test.js.
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { io as connectClient } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkInvariants } from '../../game/truco/invariants.js';
import { Incident } from '../../models/Incident.js';
import { Match } from '../../models/Match.js';
import { User } from '../../models/User.js';
import { initSockets } from '../../sockets/index.js';
import { setIo } from '../../sockets/emitter.js';
import { issueTokens } from '../../utils/tokens.js';
import * as matchService from '../matchService.js';
import * as rematchService from '../rematchService.js';
import * as roomService from '../roomService.js';
import { connectTestDb, disconnectTestDb, hasTestDb, resetTestDb } from './setupDb.js';
import { createUser, playToEnd, sleep, waitFor } from './tableHelpers.js';

const DEFAULT_MATCH_SETTINGS = { ...matchService.settings };

describe.skipIf(!hasTestDb)('tiempo real con sockets reales (integración)', () => {
  let server;
  let io;
  let url;
  let clients;

  beforeAll(async () => {
    await connectTestDb();
    server = http.createServer();
    io = initSockets(server);
    await new Promise((resolve) => server.listen(0, resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    io.close();
    setIo(null);
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    Object.assign(matchService.settings, DEFAULT_MATCH_SETTINGS, { nextHandDelayMs: 0 });
    clients = [];
  });
  afterEach(() => {
    for (const c of clients) c.socket.disconnect();
    matchService.clearRuntimes();
    rematchService.clearPending();
  });

  /** Conecta un cliente real para el usuario y registra todo lo que recibe. */
  async function connect(user) {
    const { accessToken } = issueTokens(await User.findById(user.id).lean());
    const socket = connectClient(url, { auth: { token: accessToken }, transports: ['websocket'], forceNew: true, reconnection: false });
    const c = { user, socket, events: [], state: null };
    socket.onAny((event, data) => {
      c.events.push({ event, data });
      if (event === 'game:state') c.state = data;
    });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    clients.push(c);
    return c;
  }

  /** Entra a la mesa (room:join) y espera el primer estado. */
  async function enter(c, roomId) {
    c.state = null;
    c.socket.emit('room:join', { roomId });
    await waitFor(() => c.state && String(c.state.roomId) === String(roomId));
    return c;
  }

  const act = (c, type, payload = {}, actionId = randomUUID()) =>
    c.socket.emit('game:action', { matchId: c.state.matchId, actionId, type, payload });
  const errorsOf = (c, code) => c.events.filter((e) => e.event === 'game:error' && (!code || e.data.code === code));
  const gameEvents = (c, type, from = 0) => c.events.slice(from).filter((e) => e.event === 'game:event' && e.data.type === type);
  const can = (c, type) => Boolean(c.state?.availableActions?.includes(type));
  const runtime = (c) => matchService.getRuntime(c.state.matchId);

  async function table1v1({ bet = 0 } = {}) {
    const host = await createUser({ chips: bet > 0, prefix: 'rt' });
    const guest = await createUser({ chips: bet > 0, prefix: 'rt' });
    const room = await roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet });
    await roomService.joinRoom(guest, room.id);
    const a = await enter(await connect(host), room.id);
    const b = await enter(await connect(guest), room.id);
    return { roomId: room.id, players: [a, b] };
  }

  async function table2v2() {
    const users = [];
    for (let i = 0; i < 4; i++) users.push(await createUser({ chips: true, prefix: 'rt4' }));
    const room = await roomService.createRoom(users[0], { uuid: randomUUID(), targetPoints: 15, bet: 0, mode: '2v2' });
    for (const [i, u] of users.slice(1).entries()) await roomService.joinRoom(u, room.id, { seat: i + 1 });
    for (const u of users) await roomService.confirmReady(u, room.id);
    const players = [];
    for (const u of users) players.push(await enter(await connect(u), room.id));
    return { roomId: room.id, players };
  }

  /** Espera a que todos tengan el estado más nuevo del servidor (misma cantidad de eventos aplicados). */
  async function settle(players) {
    await sleep(150);
    const rt = runtime(players[0]);
    await waitFor(() => players.every((c) => c.state.hand?.number === rt.state.hand?.number && c.state.phase === rt.state.phase));
  }

  it('7.1 R-TURNO-01: el doble clic (mismo actionId) se procesa una sola vez', async () => {
    const { players } = await table1v1();
    const actor = players.find((c) => can(c, 'PLAY_CARD'));
    const other = players.find((c) => c !== actor);
    const cardId = actor.state.hand.myCards[0];
    const actionId = randomUUID();
    act(actor, 'PLAY_CARD', { cardId }, actionId);
    act(actor, 'PLAY_CARD', { cardId }, actionId);
    await waitFor(() => gameEvents(other, 'CARD_PLAYED').length >= 1);
    await sleep(200);
    expect(gameEvents(other, 'CARD_PLAYED')).toHaveLength(1);
    expect(runtime(actor).handLog.events.filter((e) => e.action === 'PLAY_CARD')).toHaveLength(1);

    // Doble clic con un actionId nuevo (otro intento): el segundo se rechaza con un error claro
    const caller = players.find((c) => can(c, 'CALL_TRUCO'));
    caller.events.length = 0;
    act(caller, 'CALL_TRUCO');
    act(caller, 'CALL_TRUCO');
    await waitFor(() => errorsOf(caller).length === 1);
    expect(gameEvents(caller, 'CALL')).toHaveLength(1);
    expect(checkInvariants(runtime(caller).state)).toEqual([]);
  });

  it('7.2 R-TURNO-01: dos acciones casi simultáneas de jugadores distintos: solo prospera la válida', async () => {
    const { players } = await table1v1();
    const onTurn = players.find((c) => can(c, 'CALL_TRUCO'));
    const waiting = players.find((c) => c !== onTurn);
    act(onTurn, 'CALL_TRUCO');
    act(waiting, 'PLAY_CARD', { cardId: waiting.state.hand.myCards[0] });
    await waitFor(() => errorsOf(waiting).length === 1);
    expect(errorsOf(waiting)[0].data.code).toBe('NOT_YOUR_TURN');
    expect(errorsOf(waiting)[0].data.message).toBeTruthy();
    expect(gameEvents(waiting, 'CARD_PLAYED')).toHaveLength(0);
    await waitFor(() => can(waiting, 'ACCEPT'));
  });

  it('7.3 R-TRUCO-01: en 2 vs 2 solo responde el rival que le toca; el compañero y la otra pareja reciben error', async () => {
    const { players } = await table2v2();
    const caller = players.find((c) => can(c, 'CALL_TRUCO'));
    act(caller, 'CALL_TRUCO');
    await waitFor(() => players.some((c) => can(c, 'ACCEPT')));
    const responder = players.find((c) => can(c, 'ACCEPT'));
    expect(responder.state.me.team).not.toBe(caller.state.me.team);
    const responderPartner = players.find((c) => c !== responder && c.state.me.team === responder.state.me.team);
    const callerPartner = players.find((c) => c !== caller && c.state.me.team === caller.state.me.team);

    act(responderPartner, 'ACCEPT');
    act(callerPartner, 'ACCEPT');
    await waitFor(() => errorsOf(responderPartner).length === 1 && errorsOf(callerPartner).length === 1);
    expect(errorsOf(responderPartner)[0].data.code).toBe('NOT_YOUR_TURN');
    expect(runtime(caller).state.hand.pending).toBeTruthy();

    act(responder, 'ACCEPT');
    await waitFor(() => runtime(caller).state.hand.truco.level === 2 && !runtime(caller).state.hand.pending);
  });

  it('7.4 R-TIEMPO-01: una jugada que llega justo al vencer el reloj: se aplica una sola de las dos cosas', async () => {
    Object.assign(matchService.settings, { turnTimeoutMs: 400 });
    const { players } = await table1v1();
    let trials = 0;
    for (let jitter = -40; jitter <= 40 && trials < 8; jitter += 10) {
      if (runtime(players[0]).finished) break;
      await settle(players);
      const actor = players.find((c) => can(c, 'PLAY_CARD'));
      if (!actor || !actor.state.turn || actor.state.turn.remainingMs < 250) continue;
      trials += 1;
      const marks = players.map((c) => c.events.length);
      const cardId = actor.state.hand.myCards[0];
      setTimeout(() => act(actor, 'PLAY_CARD', { cardId }), Math.max(0, actor.state.turn.remainingMs + jitter));
      const timedOut = () => players[0].events.slice(marks[0]).some((e) => e.event === 'game:event' && e.data.type === 'TURN_TIMEOUT' && e.data.playerId === actor.user.id);
      const played = () => players[0].events.slice(marks[0]).some((e) => e.event === 'game:event' && e.data.type === 'CARD_PLAYED' && e.data.cardId === cardId);
      await waitFor(() => timedOut() || played());
      await sleep(80);
      // Nunca las dos: o jugó la carta, o perdió la mano por tiempo (y la jugada tardía se rechaza)
      expect(timedOut() && played()).toBe(false);
      if (timedOut()) await waitFor(() => errorsOf(actor).length > 0 || runtime(actor).finished);
      expect(checkInvariants(runtime(actor).state)).toEqual([]);
      for (const c of players) c.events.splice(0, c.events.length);
    }
    expect(trials).toBeGreaterThanOrEqual(3);
    expect(await Incident.countDocuments({})).toBe(0);
  });

  it('7.5 R-ABAND-01: se puede jugar mientras el rival está desconectado, y al volver ve todo', async () => {
    const { roomId, players } = await table1v1();
    const actor = players.find((c) => can(c, 'PLAY_CARD'));
    const rival = players.find((c) => c !== actor);
    rival.socket.disconnect();
    await waitFor(() => actor.state.disconnected?.[rival.user.id]);
    const cardId = actor.state.hand.myCards[0];
    act(actor, 'PLAY_CARD', { cardId });
    await waitFor(() => gameEvents(actor, 'CARD_PLAYED').length === 1);

    const back = await enter(await connect(rival.user), roomId);
    expect(back.state.hand.bazas[0].plays).toEqual([{ playerId: actor.user.id, cardId }]);
    expect(can(back, 'PLAY_CARD')).toBe(true);
    await waitFor(() => !actor.state.disconnected?.[rival.user.id]);

    // Y el propio jugador: se reconecta y sigue jugando con la conexión nueva
    back.socket.disconnect();
    const again = await enter(await connect(rival.user), roomId);
    act(again, 'PLAY_CARD', { cardId: again.state.hand.myCards[0] });
    await waitFor(() => gameEvents(actor, 'CARD_PLAYED').length === 2);
  });

  it('7.6 R-ABAND-01: reconexión en los momentos críticos (canto pendiente, envido, fin de mano, fin de partida, revancha)', async () => {
    const { roomId, players } = await table1v1();
    const reconnect = async (c) => {
      c.socket.disconnect();
      const fresh = await enter(await connect(c.user), roomId);
      players[players.indexOf(c)] = fresh;
      return fresh;
    };

    // Envido pendiente
    const envCaller = players.find((c) => can(c, 'CALL_ENVIDO'));
    act(envCaller, 'CALL_ENVIDO');
    let responder = players.find((c) => c !== envCaller);
    await waitFor(() => can(responder, 'ACCEPT'));
    responder = await reconnect(responder);
    expect(responder.state.availableActions).toEqual(expect.arrayContaining(['ACCEPT', 'REJECT']));
    act(responder, 'ACCEPT');
    await waitFor(() => gameEvents(envCaller, 'ENVIDO_RESULT').length === 1);

    // Truco pendiente
    await settle(players);
    const trucoCaller = players.find((c) => can(c, 'CALL_TRUCO'));
    act(trucoCaller, 'CALL_TRUCO');
    let trucoResponder = players.find((c) => c !== trucoCaller);
    await waitFor(() => can(trucoResponder, 'ACCEPT'));
    trucoResponder = await reconnect(trucoResponder);
    expect(can(trucoResponder, 'ACCEPT')).toBe(true);
    expect(trucoResponder.state.hand.envido.status).toBeTruthy();

    // Fin de la mano: el que no quiso, al volver, ve la mano siguiente
    const hand = runtime(trucoCaller).state.handNumber;
    act(trucoResponder, 'REJECT');
    await waitFor(() => runtime(trucoCaller).state.handNumber === hand + 1);
    const late = await reconnect(players[0]);
    expect(late.state.handNumber).toBe(hand + 1);
    expect(late.state.score).toEqual(runtime(late).state.score);

    // Fin de la partida y revancha pedida mientras el otro no estaba
    await playToEnd(late.state.matchId, 31337);
    const [p0, p1] = players;
    await waitFor(() => p0.events.some((e) => e.event === 'game:finished'));
    p1.socket.disconnect();
    p0.socket.emit('game:rematch', { matchId: p0.state.matchId });
    await waitFor(() => p0.events.some((e) => e.event === 'game:rematch' && e.data.state === 'requested'));
    const returning = await enter(await connect(p1.user), roomId).catch(() => null);
    const comeback = returning || clients[clients.length - 1];
    await waitFor(() => comeback.events.some((e) => e.event === 'game:finished'));
    await waitFor(() => comeback.events.some((e) => e.event === 'game:rematch'));
    const status = comeback.events.find((e) => e.event === 'game:rematch').data;
    expect(status).toMatchObject({ state: 'requested', by: p0.user.id });
    expect(comeback.events.findIndex((e) => e.event === 'game:finished'))
      .toBeLessThan(comeback.events.findIndex((e) => e.event === 'game:rematch'));
  });

  it('7.7 I-S1: dos pestañas del mismo usuario: la vieja recibe SESSION_REPLACED y ya no puede jugar', async () => {
    const { roomId, players } = await table1v1();
    const actor = players.find((c) => can(c, 'PLAY_CARD'));
    const rival = players.find((c) => c !== actor);
    const cardId = actor.state.hand.myCards[0];
    const second = await enter(await connect(actor.user), roomId);
    await waitFor(() => errorsOf(actor, 'SESSION_REPLACED').length === 1);

    act(actor, 'PLAY_CARD', { cardId });
    await waitFor(() => errorsOf(actor, 'SESSION_REPLACED').length === 2);
    await sleep(150);
    expect(gameEvents(rival, 'CARD_PLAYED')).toHaveLength(0);

    // La pestaña nueva sí juega, y la vieja ya no recibe el estado
    const before = actor.events.length;
    act(second, 'PLAY_CARD', { cardId });
    await waitFor(() => gameEvents(rival, 'CARD_PLAYED').length === 1);
    await sleep(150);
    expect(actor.events.slice(before).filter((e) => e.event === 'game:state' || e.event === 'game:event')).toEqual([]);
  });

  it('7.9 R-VIS-04 / I-V5: varias partidas simultáneas con bots por socket: ningún mensaje cruza de una partida a otra', async () => {
    const TABLES = 10;
    const tables = [];
    for (let i = 0; i < TABLES; i++) tables.push(await table1v1());
    const all = tables.flatMap((t) => t.players);
    const matchOf = new Map(all.map((c) => [c, c.state.matchId]));

    // Cada bot juega lo primero que le toca cada vez que recibe un estado (con algo de azar en los cantos)
    let seed = 7;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (const c of all) {
      c.socket.on('game:state', (view) => {
        const options = view.availableActions.filter((t) => t !== 'GO_TO_DECK');
        if (!options.length || view.phase !== 'playing') return;
        const type = options.includes('PLAY_CARD') && rand(3) > 0 ? 'PLAY_CARD' : options[rand(options.length)];
        const payload = type === 'PLAY_CARD' ? { cardId: view.hand.myCards[0] } : {};
        setTimeout(() => c.socket.emit('game:action', { matchId: view.matchId, actionId: randomUUID(), type, payload }), rand(15));
      });
      // Arranque: el primer estado ya llegó antes de registrar el bot
      const options = c.state.availableActions;
      if (options.includes('PLAY_CARD')) c.socket.emit('game:action', { matchId: c.state.matchId, actionId: randomUUID(), type: 'PLAY_CARD', payload: { cardId: c.state.hand.myCards[0] } });
    }

    await waitFor(() => all.every((c) => c.events.some((e) => e.event === 'game:finished')), { timeoutMs: 120000, stepMs: 100 });

    for (const c of all) {
      const mine = matchOf.get(c);
      for (const { event, data } of c.events) {
        if (event === 'game:state' || event === 'game:finished') expect(data.matchId).toBe(mine);
        if (event === 'game:event' && data.cardId) {
          // Toda carta que ve jugar es de su propia partida
          const rt = matchService.getRuntime(mine);
          expect(rt.state.players.some((p) => p.id === data.playerId)).toBe(true);
        }
      }
      // Nunca un error que no sea de reglas (los bots pueden pisarse con el reloj, pero no con otra partida)
      for (const e of errorsOf(c)) expect(['NOT_YOUR_TURN', 'INVALID_ACTION', 'RATE_LIMITED', 'MATCH_NOT_ACTIVE']).toContain(e.data.code);
    }
    const finished = await Match.countDocuments({ status: 'finished' });
    expect(finished).toBe(TABLES);
    expect(await Incident.countDocuments({})).toBe(0);
  }, 180000);

  it('7.10 R-TURNO-01: mensajes inválidos, repetidos o fuera de orden se rechazan sin tocar el estado', async () => {
    const { players } = await table1v1();
    const actor = players.find((c) => can(c, 'PLAY_CARD'));
    const rt = runtime(actor);
    const before = JSON.stringify(rt.state);

    // Payload mal formado, acción inexistente, partida ajena, carta que no tiene
    actor.socket.emit('game:action', { matchId: actor.state.matchId, type: 'PLAY_CARD' });
    act(actor, 'NO_EXISTE');
    actor.socket.emit('game:action', { matchId: '0123456789abcdef01234567', actionId: randomUUID(), type: 'PLAY_CARD', payload: { cardId: '1-espada' } });
    const notMine = players.find((c) => c !== actor).state.hand.myCards[0];
    act(actor, 'PLAY_CARD', { cardId: notMine });
    await waitFor(() => errorsOf(actor).length === 4);
    expect(JSON.stringify(rt.state)).toBe(before);

    // Una acción vieja repetida después de otras (mismo actionId) se ignora
    const first = randomUUID();
    const cardId = actor.state.hand.myCards[0];
    act(actor, 'PLAY_CARD', { cardId }, first);
    await waitFor(() => rt.state.hand.bazas[0].plays.length === 1);
    const rival = players.find((c) => c !== actor);
    await waitFor(() => can(rival, 'PLAY_CARD'));
    act(rival, 'PLAY_CARD', { cardId: rival.state.hand.myCards[0] });
    await waitFor(() => rt.state.hand.bazas[0].plays.length === 2);
    const afterTwo = JSON.stringify(rt.state);
    act(actor, 'PLAY_CARD', { cardId }, first);
    await sleep(200);
    expect(JSON.stringify(rt.state)).toBe(afterTwo);
    expect(checkInvariants(rt.state)).toEqual([]);
  });
});
