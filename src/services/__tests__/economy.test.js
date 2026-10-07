// Economía sin base de datos: reparto del pozo y comisión en enteros (R-ECO-03, R-ECO-06).
import { describe, expect, it } from 'vitest';
import { houseFee } from '../../utils/houseFee.js';
import { computeSettlement } from '../betService.js';

const table = (bet, mode) => ({
  status: 'finished',
  endReason: 'normal',
  winnerTeam: 1,
  players: (mode === '2v2' ? [0, 1, 0, 1] : [0, 1]).map((team, i) => ({ userId: `u${i}`, team, betLocked: bet }))
});

describe('comisión y reparto del pozo', () => {
  it('R-ECO-06: la comisión es entera y exacta en puntos básicos (sin errores de coma flotante)', () => {
    expect(houseFee(100, 0.29)).toBe(29); // con coma flotante daría 28
    expect(houseFee(1000, 0.07)).toBe(70);
    expect(houseFee(999, 0.05)).toBe(49);
    expect(houseFee(1000, 0)).toBe(0);
    for (let bps = 0; bps <= 2000; bps += 7) {
      for (const pot of [0, 1, 7, 20, 99, 100, 1000, 12345, 40000]) {
        const fee = houseFee(pot, bps / 10000);
        expect(Number.isInteger(fee)).toBe(true);
        expect(fee).toBe(Math.floor((pot * bps) / 10000));
      }
    }
  });

  it('R-ECO-06 / R-ECO-03: lo bloqueado = lo pagado + lo devuelto + la casa, en 1 vs 1 y 2 vs 2 y con cualquier comisión', () => {
    let casos = 0;
    for (const mode of ['1v1', '2v2']) {
      for (const bet of [10, 20, 30, 100, 250, 1000, 9990]) {
        for (let bps = 0; bps <= 2500; bps += 13) {
          const match = table(bet, mode);
          const { payouts, refunds, houseCut } = computeSettlement(match, bps / 10000);
          const pot = match.players.reduce((s, p) => s + p.betLocked, 0);
          const paid = [...payouts, ...refunds].reduce((s, p) => s + p.amount, 0);
          for (const p of payouts) expect(Number.isInteger(p.amount)).toBe(true);
          expect(paid + houseCut).toBe(pot);
          expect(houseCut).toBeGreaterThanOrEqual(houseFee(pot, bps / 10000));
          expect(houseCut).toBeLessThan(houseFee(pot, bps / 10000) + payouts.length); // el resto es menor que la cantidad de ganadores
          // Con comisión 0, cada ganador cobra exactamente el pozo / ganadores
          if (bps === 0) for (const p of payouts) expect(p.amount).toBe(pot / payouts.length);
          casos += 1;
        }
      }
    }
    expect(casos).toBeGreaterThan(2000);
  });
});
