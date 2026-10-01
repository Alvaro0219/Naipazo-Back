import { describe, expect, it } from 'vitest';
import { addDaysToKey, dateKeyInTz, nextDayStartInTz, startOfDayInTz } from '../dates.js';

const BA = 'America/Argentina/Buenos_Aires'; // UTC-3, sin horario de verano

describe('dateKeyInTz', () => {
  it('usa el día calendario de Buenos Aires, no el de UTC', () => {
    // 02:30 UTC del 1/10 = 23:30 del 30/9 en Buenos Aires
    expect(dateKeyInTz(new Date('2026-10-01T02:30:00Z'), BA)).toBe('2026-09-30');
    expect(dateKeyInTz(new Date('2026-10-01T03:00:00Z'), BA)).toBe('2026-10-01');
  });
});

describe('addDaysToKey', () => {
  it('cruza fin de mes y de año', () => {
    expect(addDaysToKey('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToKey('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('startOfDayInTz / nextDayStartInTz', () => {
  it('la medianoche de Buenos Aires son las 03:00 UTC', () => {
    expect(startOfDayInTz('2026-10-01', BA).toISOString()).toBe('2026-10-01T03:00:00.000Z');
  });

  it('el próximo crédito es la siguiente medianoche local', () => {
    expect(nextDayStartInTz(new Date('2026-09-30T23:59:00Z'), BA).toISOString())
      .toBe('2026-10-01T03:00:00.000Z');
    expect(nextDayStartInTz(new Date('2026-10-01T02:59:59Z'), BA).toISOString())
      .toBe('2026-10-01T03:00:00.000Z');
    expect(nextDayStartInTz(new Date('2026-10-01T03:00:00Z'), BA).toISOString())
      .toBe('2026-10-02T03:00:00.000Z');
  });

  it('funciona en zonas con horario de verano', () => {
    // Madrid: 29/3/2026 cambia a UTC+2; la medianoche del 30/3 son las 22:00 UTC del 29/3
    expect(startOfDayInTz('2026-03-30', 'Europe/Madrid').toISOString()).toBe('2026-03-29T22:00:00.000Z');
  });
});
