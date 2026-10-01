import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LedgerEntry } from '../../models/LedgerEntry.js';
import { MatchHandLog } from '../../models/MatchHandLog.js';
import { User } from '../../models/User.js';
import { setTestSink } from '../../sockets/emitter.js';
import * as adminService from '../adminService.js';
import { login, refresh, register } from '../authService.js';
import * as historyService from '../historyService.js';
import * as matchService from '../matchService.js';
import * as rankingService from '../rankingService.js';
import * as userService from '../userService.js';
import { getLedgerSum } from '../walletService.js';
import { connectTestDb, disconnectTestDb, hasTestDb, resetTestDb } from './setupDb.js';
import { createUser, playToEnd, startTable } from './tableHelpers.js';

const page = { skip: 0, limit: 20 };

describe.skipIf(!hasTestDb)('historial, ranking, perfil y admin (integración)', () => {
  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    await resetTestDb();
    matchService.settings.nextHandDelayMs = 0;
    setTestSink(() => {});
  });
  afterEach(() => {
    setTestSink(null);
    matchService.clearRuntimes();
  });

  describe('historial', () => {
    it('lista mis partidas con resultado y fichas, y el detalle no revela cartas del rival no jugadas', async () => {
      const { host, guest, matchId } = await startTable({ bet: 100 });
      await playToEnd(matchId);

      const { items, total } = await historyService.listMyMatches(host.id, page);
      expect(total).toBe(1);
      const item = items[0];
      expect(item.opponent.username).toBe(guest.username);
      expect(['won', 'lost']).toContain(item.result);
      expect(item.chipsNet).toBe(item.result === 'won' ? 100 : -100);

      const detail = await historyService.getMatchDetail(host.id, matchId);
      expect(detail.hands.length).toBe(detail.handsPlayed);

      // Para cada mano: las cartas del rival que aparecen tienen que ser cartas que jugó
      const logs = await MatchHandLog.find({ matchId }).lean();
      for (const hand of detail.hands) {
        const log = logs.find((l) => l.handNumber === hand.handNumber);
        const played = new Set(hand.plays.map((p) => p.cardId));
        const rivalUnplayed = log.dealt[guest.id].filter((c) => !played.has(c));
        const json = JSON.stringify(hand);
        for (const card of rivalUnplayed) expect(json).not.toContain(`"${card}"`);
        expect(hand.myCards).toEqual(log.dealt[host.id]);
        expect(hand).not.toHaveProperty('deck');
      }
    }, 60000);

    it('solo los jugadores ven el detalle, y solo de partidas cerradas', async () => {
      const outsider = await createUser();
      const { host, matchId } = await startTable();
      await expect(historyService.getMatchDetail(host.id, matchId)).rejects.toMatchObject({ code: 'MATCH_IN_PROGRESS' });
      await expect(historyService.getMatchDetail(outsider.id, matchId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('ranking', () => {
    it('ordena por partidas ganadas y por fichas, histórico y por período', async () => {
      const a = await createUser({ chips: true });
      const b = await createUser({ chips: true });
      const first = await startTable({ bet: 100, host: a, guest: b });
      await playToEnd(first.matchId);
      matchService.clearRuntimes();

      const winnerId = (await User.findOne({ 'stats.won': 1 }).lean())._id.toString();
      for (const period of ['all', 'week']) {
        const byWins = await rankingService.getRanking({ by: 'won', period }, page);
        expect(byWins.items[0]).toMatchObject({ rank: 1, userId: winnerId, won: 1, played: 1 });
        expect(byWins.total).toBe(2);

        const byChips = await rankingService.getRanking({ by: 'chips', period }, page);
        expect(byChips.items).toHaveLength(1); // solo quien ganó fichas netas
        expect(byChips.items[0]).toMatchObject({ userId: winnerId, chips: 100 });
      }
    }, 60000);

    it('no muestra cuentas bloqueadas', async () => {
      const admin = await createUser();
      const { host, guest, matchId } = await startTable();
      await playToEnd(matchId);
      await adminService.setUserActive(admin.id, host.id, false);
      const { items } = await rankingService.getRanking({ by: 'won', period: 'all' }, page);
      expect(items.map((i) => i.userId)).toEqual([guest.id]);
    }, 60000);
  });

  describe('cambio de contraseña', () => {
    it('exige la actual, cierra las otras sesiones y devuelve tokens nuevos', async () => {
      const session = await register({ username: 'Clave', email: 'clave@test.com', password: 'secreta123' });
      await expect(userService.changePassword(session.user.id, { currentPassword: 'mal', newPassword: 'otraclave1' }))
        .rejects.toMatchObject({ code: 'WRONG_PASSWORD', status: 400 });

      const updated = await userService.changePassword(session.user.id, { currentPassword: 'secreta123', newPassword: 'otraclave1' });
      expect(updated.accessToken).toBeTruthy();
      await expect(refresh(session.refreshToken)).rejects.toMatchObject({ code: 'INVALID_REFRESH' });
      expect((await refresh(updated.refreshToken)).user.id).toBe(session.user.id);
      await expect(login({ identifier: 'clave', password: 'secreta123' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
      expect((await login({ identifier: 'clave', password: 'otraclave1' })).user.id).toBe(session.user.id);
    });
  });

  describe('admin', () => {
    it('busca usuarios por nombre o email', async () => {
      await createUser({ prefix: 'pepe' });
      await createUser({ prefix: 'juana' });
      const { items, total } = await adminService.listUsers({ search: 'PEPE' }, page);
      expect(total).toBe(1);
      expect(items[0].username).toMatch(/^pepe/);
    });

    it('bloquear impide entrar y renovar la sesión; no se puede bloquear a sí mismo', async () => {
      const admin = await createUser();
      const session = await register({ username: 'Bloqueable', email: 'b@test.com', password: 'secreta123' });
      await expect(adminService.setUserActive(admin.id, admin.id, false)).rejects.toMatchObject({ code: 'CANNOT_BLOCK_SELF' });

      await adminService.setUserActive(admin.id, session.user.id, false);
      await expect(login({ identifier: 'bloqueable', password: 'secreta123' })).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
      await expect(refresh(session.refreshToken)).rejects.toMatchObject({ code: 'INVALID_REFRESH' });

      await adminService.setUserActive(admin.id, session.user.id, true);
      expect((await login({ identifier: 'bloqueable', password: 'secreta123' })).user.id).toBe(session.user.id);
    });

    it('el ajuste de fichas deja asiento, es idempotente y no deja saldo negativo', async () => {
      const admin = await createUser();
      const user = await createUser({ chips: true });
      const operationId = randomUUID();
      await adminService.adjustChips(admin.id, user.id, { amount: 500, reason: 'compensación', operationId });
      const again = await adminService.adjustChips(admin.id, user.id, { amount: 500, reason: 'compensación', operationId });
      expect(again.entry.duplicated).toBe(true);
      expect(again.user.balance).toBe(1500);

      await expect(adminService.adjustChips(admin.id, user.id, { amount: -5000, reason: 'error', operationId: randomUUID() }))
        .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
      const entry = await LedgerEntry.findOne({ type: 'ADMIN_ADJUST' }).lean();
      expect(entry).toMatchObject({ amount: 500, note: 'compensación' });
      expect(await getLedgerSum(user.id)).toBe(1500);
    });
  });
});
