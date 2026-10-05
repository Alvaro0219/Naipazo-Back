import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LedgerEntry } from '../../models/LedgerEntry.js';
import { Match } from '../../models/Match.js';
import { Room } from '../../models/Room.js';
import { Tournament } from '../../models/Tournament.js';
import { User } from '../../models/User.js';
import { setTestSink } from '../../sockets/emitter.js';
import * as matchService from '../matchService.js';
import * as rematchService from '../rematchService.js';
import * as tournamentService from '../tournamentService.js';
import { getLedgerSum } from '../walletService.js';
import { connectTestDb, disconnectTestDb, hasTestDb, resetTestDb } from './setupDb.js';
import { createUser, fakeSocket, playToEnd, sleep, startTable, waitFor } from './tableHelpers.js';

const DEFAULT_MATCH_SETTINGS = { ...matchService.settings };
const DEFAULT_REMATCH_SETTINGS = { ...rematchService.settings };
const balanceOf = async (userId) => (await User.findById(userId).lean()).balance;

describe.skipIf(!hasTestDb)('revancha (integración)', () => {
  let emissions;
  const rematchEvents = () => emissions.filter((e) => e.event === 'game:rematch').map((e) => e.data);

  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    await resetTestDb();
    Object.assign(matchService.settings, DEFAULT_MATCH_SETTINGS, { nextHandDelayMs: 0 });
    Object.assign(rematchService.settings, DEFAULT_REMATCH_SETTINGS);
    emissions = [];
    setTestSink((e) => emissions.push(e));
  });
  afterEach(() => {
    setTestSink(null);
    rematchService.clearPending();
    matchService.clearRuntimes();
    tournamentService.clearTimers();
  });

  async function finishedTable(options) {
    const table = await startTable(options);
    await playToEnd(table.matchId);
    return table;
  }

  it('si aceptan los dos arranca una sala nueva con la misma apuesta bloqueada otra vez', async () => {
    const { host, guest, room, matchId } = await finishedTable({ bet: 100 });
    expect(matchService.getRuntime(matchId).finished).toBe(true);

    await rematchService.requestRematch(host.id, matchId);
    expect(rematchEvents().at(-1)).toMatchObject({ matchId, state: 'requested', by: host.id });
    // Pedirla dos veces el mismo jugador no la arranca
    await rematchService.requestRematch(host.id, matchId);
    expect(await Room.countDocuments()).toBe(1);

    const result = await rematchService.requestRematch(guest.id, matchId);
    expect(result.state).toBe('started');
    const started = rematchEvents().at(-1);
    expect(started).toMatchObject({ matchId, state: 'started' });

    const newRoom = await Room.findById(started.roomId).lean();
    expect(String(newRoom.rematchOf)).toBe(room.id);
    expect(newRoom.status).toBe('playing');
    expect(newRoom.config).toMatchObject({ targetPoints: 15, bet: 100 });
    const newMatch = await Match.findById(newRoom.matchId).lean();
    expect(newMatch.players.every((p) => p.betLocked === 100)).toBe(true);
    expect(matchService.getRuntime(newRoom.matchId)).toBeTruthy();
    expect(await LedgerEntry.countDocuments({ type: 'BET_LOCK', refId: newMatch._id })).toBe(2);
    for (const u of [host, guest]) expect(await balanceOf(u.id)).toBe(await getLedgerSum(u.id));

    // Ya usada: no se puede volver a pedir
    await expect(rematchService.requestRematch(host.id, matchId)).rejects.toMatchObject({ code: 'REMATCH_UNAVAILABLE' });
  }, 30000);

  it('si a alguno no le alcanza el saldo, no arranca ni bloquea nada', async () => {
    const { host, guest, matchId } = await finishedTable({ bet: 600 });
    const before = [await balanceOf(host.id), await balanceOf(guest.id)];
    expect(Math.min(...before)).toBeLessThan(600); // el que perdió quedó con 400

    await rematchService.requestRematch(host.id, matchId);
    const result = await rematchService.requestRematch(guest.id, matchId);
    expect(result.state).toBe('failed');
    expect(rematchEvents().at(-1)).toMatchObject({ state: 'failed' });
    expect(rematchEvents().at(-1).message).toMatch(/no tiene fichas suficientes para la revancha/);
    expect(await Room.countDocuments()).toBe(1);
    expect([await balanceOf(host.id), await balanceOf(guest.id)]).toEqual(before);
  }, 30000);

  it('rechazarla la cierra para los dos', async () => {
    const { host, guest, matchId } = await finishedTable({});
    await rematchService.requestRematch(host.id, matchId);
    rematchService.declineRematch(guest.id, matchId);
    expect(rematchEvents().at(-1)).toMatchObject({ state: 'declined', by: guest.id });
    await expect(rematchService.requestRematch(guest.id, matchId)).rejects.toMatchObject({ code: 'REMATCH_UNAVAILABLE' });
  }, 30000);

  it('caduca si nadie la acepta a tiempo', async () => {
    rematchService.settings.windowMs = 50;
    const { host, guest, matchId } = await finishedTable({});
    await rematchService.requestRematch(host.id, matchId);
    await sleep(120);
    expect(rematchEvents().at(-1)).toMatchObject({ state: 'expired' });
    await expect(rematchService.requestRematch(guest.id, matchId)).rejects.toMatchObject({ code: 'REMATCH_UNAVAILABLE' });
  }, 30000);

  it('no se puede pedir antes de terminar ni en partidas de torneo', async () => {
    const { host, matchId } = await startTable({});
    await expect(rematchService.requestRematch(host.id, matchId)).rejects.toMatchObject({ code: 'REMATCH_UNAVAILABLE' });

    const players = [];
    for (let i = 0; i < 4; i++) players.push(await createUser());
    const t = await tournamentService.createTournament(players[0], { uuid: randomUUID(), size: 4, buyIn: 0, targetPoints: 15 });
    for (const p of players.slice(1)) await tournamentService.joinTournament(p, t.id);
    const semi = (await Tournament.findById(t.id).lean()).bracket[0];
    const semiId = String(semi.matchId);
    for (const id of semi.players) await matchService.attachSocket(semiId, String(id), fakeSocket(`t-${id}`));
    await playToEnd(semiId);
    await waitFor(() => matchService.getRuntime(semiId).finished);
    await expect(rematchService.requestRematch(String(semi.players[0]), semiId))
      .rejects.toMatchObject({ code: 'REMATCH_NOT_ALLOWED' });
  }, 30000);
});
