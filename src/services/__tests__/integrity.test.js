import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import { Match } from '../../models/Match.js';
import { User } from '../../models/User.js';
import { setTestSink } from '../../sockets/emitter.js';
import * as adminService from '../adminService.js';
import * as matchService from '../matchService.js';
import { getRanking } from '../rankingService.js';
import * as roomService from '../roomService.js';
import { connectTestDb, disconnectTestDb, hasTestDb, resetTestDb } from './setupDb.js';
import { createUser, fakeSocket } from './tableHelpers.js';

const DEFAULT_MATCH_SETTINGS = { ...matchService.settings };

/** Juega una partida privada en la que `loser` abandona: gana `winner`. */
async function privateMatch(winner, loser, bet) {
  const room = await roomService.createRoom(winner, { uuid: randomUUID(), targetPoints: 15, bet, isPrivate: true });
  const { matchId } = await roomService.joinRoomByCode(loser, room.code);
  await matchService.attachSocket(matchId, winner.id, fakeSocket(`s-${winner.id}`));
  await matchService.attachSocket(matchId, loser.id, fakeSocket(`s-${loser.id}`));
  await matchService.abandonMatch(loser.id, matchId);
  for (let i = 0; i < 200 && !matchService.getRuntime(matchId)?.finished; i++) await new Promise((r) => setTimeout(r, 10));
  return matchId;
}

describe.skipIf(!hasTestDb)('integridad de fichas (integración)', () => {
  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    await resetTestDb();
    Object.assign(matchService.settings, DEFAULT_MATCH_SETTINGS, { nextHandDelayMs: 0 });
    setTestSink(() => {});
  });
  afterEach(() => {
    setTestSink(null);
    matchService.clearRuntimes();
  });

  it('las salas privadas tienen tope de apuesta; las públicas no', async () => {
    const host = await createUser({ chips: true });
    const max = Math.min(env.privateMaxBet, env.maxBet);
    await expect(roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: max + 10, isPrivate: true }))
      .rejects.toMatchObject({ code: 'PRIVATE_BET_TOO_HIGH' });
    const ok = await roomService.createRoom(host, { uuid: randomUUID(), targetPoints: 15, bet: max, isPrivate: true });
    expect(ok.config.bet).toBe(max);
  });

  it('una partida privada queda en el historial pero no suma estadísticas ni entra al ranking', async () => {
    const [a, b] = [await createUser({ chips: true }), await createUser({ chips: true })];
    const matchId = await privateMatch(a, b, 100);

    const match = await Match.findById(matchId).lean();
    expect(match).toMatchObject({ status: 'finished', config: { isPrivate: true } });
    for (const u of [a, b]) expect((await User.findById(u.id).lean()).stats.played).toBe(0);

    for (const period of ['all', 'week']) {
      for (const by of ['won', 'chips']) {
        const { items } = await getRanking({ by, period }, { skip: 0, limit: 50 });
        expect(items.map((r) => r.userId)).not.toContain(a.id);
      }
    }
  });

  it('el reporte de flujos marca los pares donde las fichas van siempre al mismo', async () => {
    const [main, alt, other] = [await createUser({ chips: true }), await createUser({ chips: true }), await createUser({ chips: true })];
    for (let i = 0; i < 3; i++) await privateMatch(main, alt, 100);
    // Un par parejo: uno gana una y el otro otra (no llega al mínimo de partidas)
    await privateMatch(main, other, 100);
    await privateMatch(other, main, 100);

    const flows = await adminService.chipFlows({ days: 30, minMatches: 3 });
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({
      receiver: { id: main.id }, giver: { id: alt.id }, matches: 3, receiverWins: 3, giverWins: 0, chips: 300, oneDirection: true
    });

    const all = await adminService.chipFlows({ days: 30, minMatches: 1 });
    expect(all.find((f) => [f.receiver.id, f.giver.id].includes(other.id))).toMatchObject({ matches: 2, chips: 0, oneDirection: false });
  });
});
