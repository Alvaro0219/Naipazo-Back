import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { User } from '../../models/User.js';
import { checkAvailability, login, logout, refresh, register } from '../authService.js';
import { connectTestDb, disconnectTestDb, hasTestDb, resetTestDb } from './setupDb.js';

const base = { password: 'secreta123' };

describe.skipIf(!hasTestDb)('authService (integración)', () => {
  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);
  beforeEach(resetTestDb);

  it('registra, acredita las fichas del día y permite entrar por email o usuario', async () => {
    const session = await register({ ...base, username: 'Juan', email: 'juan@test.com' });
    expect(session.user.username).toBe('Juan');
    expect(session.user.balance).toBe(1000);
    expect(session.dailyGrant.granted).toBe(true);
    expect(session.accessToken).toBeTruthy();

    const byEmail = await login({ identifier: 'JUAN@test.com', password: 'secreta123' });
    const byUsername = await login({ identifier: 'juan', password: 'secreta123' });
    expect(byEmail.user.id).toBe(session.user.id);
    expect(byUsername.user.id).toBe(session.user.id);
    expect(byUsername.dailyGrant.granted).toBe(false);
  });

  it('rechaza email o usuario repetidos, sin importar mayúsculas', async () => {
    await register({ ...base, username: 'Juan', email: 'juan@test.com' });
    await expect(register({ ...base, username: 'JUAN', email: 'otro@test.com' }))
      .rejects.toMatchObject({ code: 'USERNAME_TAKEN', status: 409 });
    await expect(register({ ...base, username: 'Pedro', email: 'juan@test.com' }))
      .rejects.toMatchObject({ code: 'EMAIL_TAKEN', status: 409 });
  });

  it('con registros simultáneos del mismo usuario, solo uno prospera', async () => {
    const results = await Promise.allSettled([
      register({ ...base, username: 'Maria', email: 'maria1@test.com' }),
      register({ ...base, username: 'maria', email: 'maria2@test.com' }),
      register({ ...base, username: 'MARIA', email: 'maria3@test.com' })
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter(r => r.status === 'rejected')) {
      expect(r.reason.code).toBe('USERNAME_TAKEN');
    }
    expect(await User.countDocuments({ usernameLower: 'maria' })).toBe(1);
  });

  it('con registros simultáneos del mismo email, solo uno prospera', async () => {
    const results = await Promise.allSettled([
      register({ ...base, username: 'uno', email: 'mismo@test.com' }),
      register({ ...base, username: 'dos', email: 'mismo@test.com' })
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected').reason.code).toBe('EMAIL_TAKEN');
  });

  it('da un error genérico con credenciales inválidas', async () => {
    await register({ ...base, username: 'Ana', email: 'ana@test.com' });
    await expect(login({ identifier: 'ana', password: 'incorrecta' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Credenciales inválidas' });
    await expect(login({ identifier: 'noexiste', password: 'secreta123' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Credenciales inválidas' });
  });

  it('el refresh rota tokens y el logout los invalida', async () => {
    const session = await register({ ...base, username: 'Leo', email: 'leo@test.com' });
    const renewed = await refresh(session.refreshToken);
    expect(renewed.user.id).toBe(session.user.id);

    await logout(renewed.refreshToken);
    await expect(refresh(renewed.refreshToken)).rejects.toMatchObject({ code: 'INVALID_REFRESH' });
  });

  it('informa disponibilidad de usuario y email', async () => {
    await register({ ...base, username: 'Sofi', email: 'sofi@test.com' });
    expect(await checkAvailability({ username: 'SOFI', email: 'SOFI@test.com' })).toEqual({
      username: { available: false, reason: 'TAKEN' },
      email: { available: false, reason: 'TAKEN' }
    });
    expect((await checkAvailability({ username: 'admin' })).username.reason).toBe('RESERVED');
    expect((await checkAvailability({ username: 'a b' })).username.reason).toBe('INVALID');
    expect((await checkAvailability({ username: 'libre_1' })).username.available).toBe(true);
  });
});
