import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LedgerEntry } from '../../models/LedgerEntry.js';
import { User } from '../../models/User.js';
import { runInTransaction } from '../../utils/transaction.js';
import {
  adminAdjust, claimDailyGrantIfDue, getLedgerSum, lockBet, payoutBet, refundBet
} from '../walletService.js';
import { connectTestDb, disconnectTestDb, hasTestDb, resetTestDb } from './setupDb.js';

const DAY_1 = new Date('2026-10-01T15:00:00Z');
const DAY_1_LATE = new Date('2026-10-02T02:59:00Z'); // 23:59 del 1/10 en Buenos Aires
const DAY_2 = new Date('2026-10-02T03:00:00Z'); // 00:00 del 2/10 en Buenos Aires
const DAY_5 = new Date('2026-10-05T12:00:00Z');

let seq = 0;
async function createUser() {
  seq += 1;
  return User.create({
    username: `jugador${seq}`,
    email: `jugador${seq}@test.com`,
    passwordHash: 'x',
    acceptedTermsAt: new Date()
  });
}

async function balanceOf(userId) {
  return (await User.findById(userId).lean()).balance;
}

async function expectBalanceMatchesLedger(userId) {
  expect(await getLedgerSum(userId)).toBe(await balanceOf(userId));
}

describe.skipIf(!hasTestDb)('walletService (integración)', () => {
  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);
  beforeEach(resetTestDb);

  describe('claimDailyGrantIfDue', () => {
    it('R-ECO-01: acredita 1000 fichas la primera vez del día y no de nuevo ese día', async () => {
      const user = await createUser();
      const first = await claimDailyGrantIfDue(user._id, DAY_1);
      const second = await claimDailyGrantIfDue(user._id, DAY_1_LATE);

      expect(first.granted).toBe(true);
      expect(first.amount).toBe(1000);
      expect(first.nextGrantAt.toISOString()).toBe('2026-10-02T03:00:00.000Z');
      expect(second.granted).toBe(false);
      expect(await balanceOf(user._id)).toBe(1000);
      await expectBalanceMatchesLedger(user._id);
    });

    it('R-ECO-01: no duplica el crédito con muchas llamadas concurrentes', async () => {
      const user = await createUser();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => claimDailyGrantIfDue(user._id, DAY_1))
      );

      expect(results.filter(r => r.granted)).toHaveLength(1);
      expect(await balanceOf(user._id)).toBe(1000);
      expect(await LedgerEntry.countDocuments({ userId: user._id })).toBe(1);
    });

    it('R-ECO-01: vuelve a acreditar al día siguiente y no acumula días sin entrar', async () => {
      const user = await createUser();
      await claimDailyGrantIfDue(user._id, DAY_1);
      expect((await claimDailyGrantIfDue(user._id, DAY_2)).granted).toBe(true);
      expect((await claimDailyGrantIfDue(user._id, DAY_5)).granted).toBe(true);
      expect(await balanceOf(user._id)).toBe(3000);
      await expectBalanceMatchesLedger(user._id);
    });

    it('no acredita a usuarios bloqueados', async () => {
      const user = await createUser();
      await User.updateOne({ _id: user._id }, { isActive: false });
      expect((await claimDailyGrantIfDue(user._id, DAY_1)).granted).toBe(false);
      expect(await balanceOf(user._id)).toBe(0);
    });
  });

  describe('apuestas', () => {
    it('R-ECO-09: bloquea, paga y mantiene el saldo igual a la suma del ledger', async () => {
      const a = await createUser();
      const b = await createUser();
      await claimDailyGrantIfDue(a._id, DAY_1);
      await claimDailyGrantIfDue(b._id, DAY_1);
      const matchId = new mongoose.Types.ObjectId();

      await runInTransaction(async (session) => {
        await lockBet(matchId, a._id, 300, { session });
        await lockBet(matchId, b._id, 300, { session });
      });
      expect(await balanceOf(a._id)).toBe(700);
      expect(await balanceOf(b._id)).toBe(700);

      await payoutBet(matchId, a._id, 600);
      expect(await balanceOf(a._id)).toBe(1300);
      await expectBalanceMatchesLedger(a._id);
      await expectBalanceMatchesLedger(b._id);
    });

    it('con saldo insuficiente falla sin efectos', async () => {
      const user = await createUser();
      await claimDailyGrantIfDue(user._id, DAY_1);
      const matchId = new mongoose.Types.ObjectId();

      await expect(lockBet(matchId, user._id, 5000)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
      expect(await balanceOf(user._id)).toBe(1000);
      expect(await LedgerEntry.countDocuments({ userId: user._id, type: 'BET_LOCK' })).toBe(0);
    });

    it('si falla el bloqueo de un jugador no se bloquea el del otro', async () => {
      const rich = await createUser();
      const poor = await createUser();
      await claimDailyGrantIfDue(rich._id, DAY_1);
      const matchId = new mongoose.Types.ObjectId();

      await expect(runInTransaction(async (session) => {
        await lockBet(matchId, rich._id, 500, { session });
        await lockBet(matchId, poor._id, 500, { session });
      })).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });

      expect(await balanceOf(rich._id)).toBe(1000);
      expect(await LedgerEntry.countDocuments({ type: 'BET_LOCK' })).toBe(0);
    });

    it('R-ECO-09: es idempotente: repetir el mismo bloqueo o pago no duplica', async () => {
      const user = await createUser();
      await claimDailyGrantIfDue(user._id, DAY_1);
      const matchId = new mongoose.Types.ObjectId();

      const results = await Promise.all([
        lockBet(matchId, user._id, 100),
        lockBet(matchId, user._id, 100),
        lockBet(matchId, user._id, 100)
      ]);
      expect(results.filter(r => !r.duplicated)).toHaveLength(1);
      expect(await balanceOf(user._id)).toBe(900);

      await refundBet(matchId, user._id, 100);
      await refundBet(matchId, user._id, 100);
      expect(await balanceOf(user._id)).toBe(1000);
      await expectBalanceMatchesLedger(user._id);
    });

    it('R-ECO-09: rechaza montos no enteros o no positivos', async () => {
      const user = await createUser();
      const matchId = new mongoose.Types.ObjectId();
      await expect(lockBet(matchId, user._id, 10.5)).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
      await expect(lockBet(matchId, user._id, 0)).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
      await expect(payoutBet(matchId, user._id, -5)).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    });
  });

  describe('adminAdjust', () => {
    it('R-ECO-09: ajusta con asiento ADMIN_ADJUST y no deja saldo negativo', async () => {
      const user = await createUser();
      const admin = await createUser();
      await adminAdjust({ userId: user._id, amount: 250, adminId: admin._id, reason: 'compensación', operationId: 'op-1' });
      await expect(
        adminAdjust({ userId: user._id, amount: -500, adminId: admin._id, reason: 'x', operationId: 'op-2' })
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });

      expect(await balanceOf(user._id)).toBe(250);
      await expectBalanceMatchesLedger(user._id);
    });
  });

  describe('LedgerEntry', () => {
    it('es inmutable', async () => {
      const user = await createUser();
      await claimDailyGrantIfDue(user._id, DAY_1);
      await expect(LedgerEntry.updateOne({ userId: user._id }, { amount: 99999 })).rejects.toThrow(/inmutable/);
      await expect(LedgerEntry.deleteMany({ userId: user._id })).rejects.toThrow(/inmutable/);
    });
  });
});
