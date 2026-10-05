import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import { AuthToken } from '../../models/AuthToken.js';
import { User } from '../../models/User.js';
import * as accountService from '../accountService.js';
import * as authService from '../authService.js';
import { setTestOutbox } from '../emailService.js';
import { claimDailyGrantIfDue } from '../walletService.js';
import { connectTestDb, disconnectTestDb, hasTestDb, resetTestDb } from './setupDb.js';
import { sleep } from './tableHelpers.js';

const tokenFrom = (email) => /token=([0-9a-f]{64})/.exec(email.text)?.[1];
let counter = 0;
const newAccount = () => {
  counter += 1;
  return { username: `cuenta${Date.now() % 100000}${counter}`, email: `cuenta${Date.now()}${counter}@test.local`, password: 'clave-segura-1' };
};

describe.skipIf(!hasTestDb)('cuentas: verificación de email y recuperación de contraseña (integración)', () => {
  let outbox;
  const original = { requireEmailVerification: env.requireEmailVerification };

  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    await resetTestDb();
    outbox = [];
    setTestOutbox(outbox);
  });
  afterEach(() => {
    setTestOutbox(null);
    Object.assign(env, original);
  });

  describe('verificación', () => {
    it('el registro manda el enlace y el token sirve una sola vez', async () => {
      const data = newAccount();
      const session = await authService.register(data);
      expect(session.user.emailVerified).toBe(false);
      expect(outbox).toHaveLength(1);
      expect(outbox[0].to).toBe(data.email);
      const token = tokenFrom(outbox[0]);
      expect(token).toBeTruthy();

      // Solo se guarda el hash
      const stored = await AuthToken.findOne({ userId: session.user.id }).lean();
      expect(stored.tokenHash).not.toBe(token);

      await expect(accountService.verifyEmail(token)).resolves.toEqual({ verified: true });
      expect((await User.findById(session.user.id).lean()).emailVerified).toBe(true);
      await expect(accountService.verifyEmail(token)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    });

    it('rechaza un token vencido o inventado', async () => {
      const session = await authService.register(newAccount());
      const token = tokenFrom(outbox[0]);
      await AuthToken.updateOne({ userId: session.user.id }, { expiresAt: new Date(Date.now() - 1000) });
      await expect(accountService.verifyEmail(token)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
      await expect(accountService.verifyEmail('a'.repeat(64))).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
      await expect(accountService.verifyEmail('no-es-un-token')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    });

    it('reenviar anula el enlace anterior y tiene un límite por hora', async () => {
      const session = await authService.register(newAccount());
      const first = tokenFrom(outbox[0]);
      await accountService.resendVerification(session.user.id);
      const second = tokenFrom(outbox[1]);
      await expect(accountService.verifyEmail(first)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });

      await accountService.resendVerification(session.user.id); // 3.er email en la hora
      await expect(accountService.resendVerification(session.user.id)).rejects.toMatchObject({ code: 'TOO_MANY_EMAILS' });

      const latest = tokenFrom(outbox.at(-1));
      expect(latest).not.toBe(second);
      await accountService.verifyEmail(latest);
      await expect(accountService.resendVerification(session.user.id)).resolves.toEqual({ alreadyVerified: true });
    });

    it('con la verificación obligatoria, el crédito diario espera a que verifique', async () => {
      env.requireEmailVerification = true;
      const session = await authService.register(newAccount());
      expect(session.dailyGrant).toMatchObject({ granted: false, requiresVerification: true });
      expect(session.user.balance).toBe(0);

      await accountService.verifyEmail(tokenFrom(outbox[0]));
      const grant = await claimDailyGrantIfDue(session.user.id);
      expect(grant.granted).toBe(true);
      expect((await User.findById(session.user.id).lean()).balance).toBe(env.dailyGrantAmount);
    });

    it('sin la verificación obligatoria, el crédito llega igual (desarrollo)', async () => {
      env.requireEmailVerification = false;
      const session = await authService.register(newAccount());
      expect(session.dailyGrant.granted).toBe(true);
    });
  });

  describe('recuperación de contraseña', () => {
    it('responde lo mismo exista o no la cuenta', async () => {
      const data = newAccount();
      await authService.register(data);
      outbox.length = 0;

      const known = await accountService.forgotPassword(data.email);
      const unknown = await accountService.forgotPassword('nadie@test.local');
      expect(unknown).toEqual(known);
      await sleep(300); // el envío no se espera
      expect(outbox).toHaveLength(1);
      expect(outbox[0].to).toBe(data.email);
    });

    it('cambia la contraseña, cierra las sesiones y el enlace no se reutiliza', async () => {
      const data = newAccount();
      const session = await authService.register(data);
      outbox.length = 0;
      await accountService.forgotPassword(data.email.toUpperCase());
      await sleep(300);
      const token = tokenFrom(outbox[0]);

      await expect(accountService.resetPassword(token, 'otra-clave-123')).resolves.toEqual({ reset: true });
      await expect(accountService.resetPassword(token, 'tercera-clave-1')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });

      // La sesión vieja quedó invalidada y la contraseña vieja ya no entra
      await expect(authService.refresh(session.refreshToken)).rejects.toMatchObject({ code: 'INVALID_REFRESH' });
      await expect(authService.login({ identifier: data.email, password: data.password })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
      const relogin = await authService.login({ identifier: data.email, password: 'otra-clave-123' });
      expect(relogin.user.emailVerified).toBe(true);
    });

    it('el enlace de recuperación vence a la hora', async () => {
      const data = newAccount();
      const session = await authService.register(data);
      outbox.length = 0;
      await accountService.forgotPassword(data.email);
      await sleep(300);
      await AuthToken.updateOne({ userId: session.user.id, type: 'reset-password' }, { expiresAt: new Date(Date.now() - 1) });
      await expect(accountService.resetPassword(tokenFrom(outbox[0]), 'otra-clave-123')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    });
  });
});
