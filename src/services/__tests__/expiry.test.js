import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import { Room } from '../../models/Room.js';
import { Tournament } from '../../models/Tournament.js';
import { User } from '../../models/User.js';
import { setTestSink } from '../../sockets/emitter.js';
import * as matchService from '../matchService.js';
import * as roomService from '../roomService.js';
import * as tournamentService from '../tournamentService.js';
import { connectTestDb, disconnectTestDb, hasTestDb, resetTestDb } from './setupDb.js';
import { createUser } from './tableHelpers.js';

const minutesFromNow = (m) => new Date(Date.now() + m * 60 * 1000);
const balanceOf = async (id) => (await User.findById(id).lean()).balance;

describe.skipIf(!hasTestDb)('vencimientos de salas y torneos (integración)', () => {
  let emissions;

  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    await resetTestDb();
    emissions = [];
    setTestSink((e) => emissions.push(e));
  });
  afterEach(() => {
    setTestSink(null);
    matchService.clearRuntimes();
    tournamentService.clearTimers();
  });

  it('una sala sin rival vence a los ROOM_WAITING_TTL_MINUTES y libera al anfitrión', async () => {
    const [host, other, guest] = [await createUser({ chips: true }), await createUser(), await createUser()];
    const stale = await roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: 100 });
    const priv = await roomService.createRoom(other, { uuid: randomUUID(), targetPoints: 15, bet: 0, isPrivate: true });

    // Antes de tiempo no vence nada
    expect(await roomService.expireWaitingRooms(minutesFromNow(env.roomWaitingTtlMinutes - 1))).toBe(0);

    const later = minutesFromNow(env.roomWaitingTtlMinutes + 1);
    expect(await roomService.expireWaitingRooms(later)).toBe(2);
    expect(await Room.findById(stale.id).lean()).toMatchObject({ status: 'cancelled', cancelReason: 'expired' });
    expect((await Room.findById(priv.id).lean()).status).toBe('cancelled');
    // Idempotente
    expect(await roomService.expireWaitingRooms(later)).toBe(0);
    // El anfitrión ve que se canceló y puede crear otra
    expect(emissions.some((e) => e.event === 'room:update' && e.data.id === stale.id && e.data.cancelReason === 'expired')).toBe(true);
    await expect(roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: 0 })).resolves.toMatchObject({ status: 'waiting' });
    // Con el código ya no se entra
    await expect(roomService.joinRoomByCode(guest, priv.code)).rejects.toMatchObject({ code: 'ROOM_CODE_NOT_FOUND' });
  });

  it('una sala que ya arrancó no vence', async () => {
    const [host, guest] = [await createUser(), await createUser()];
    const room = await roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: 0 });
    await roomService.joinRoom(guest, room.id);
    expect(await roomService.expireWaitingRooms(minutesFromNow(env.roomWaitingTtlMinutes + 5))).toBe(0);
    expect((await Room.findById(room.id).lean()).status).toBe('playing');
  });

  it('R-ECO-07: un torneo sin completar vence y devuelve todas las inscripciones', async () => {
    const players = [await createUser({ chips: true }), await createUser({ chips: true }), await createUser({ chips: true })];
    const before = await Promise.all(players.map((p) => balanceOf(p.id)));
    const t = await tournamentService.createTournament(players[0], { uuid: randomUUID(), size: 4, buyIn: 300, targetPoints: 15 });
    await tournamentService.joinTournament(players[1], t.id);
    await tournamentService.joinTournament(players[2], t.id);
    expect(await balanceOf(players[0].id)).toBe(before[0] - 300);

    expect(await tournamentService.expireWaitingTournaments(minutesFromNow(env.tournamentWaitingTtlMinutes - 1))).toBe(0);
    const later = minutesFromNow(env.tournamentWaitingTtlMinutes + 1);
    expect(await tournamentService.expireWaitingTournaments(later)).toBe(1);
    expect(await tournamentService.expireWaitingTournaments(later)).toBe(0);

    expect(await Tournament.findById(t.id).lean()).toMatchObject({ status: 'cancelled', cancelReason: 'expired', settled: true });
    expect(await Promise.all(players.map((p) => balanceOf(p.id)))).toEqual(before);
    // Quedan libres para otra cosa
    await expect(roomService.createRoom(players[1], { uuid: randomUUID(), targetPoints: 15, bet: 0 })).resolves.toMatchObject({ status: 'waiting' });
  });
});
