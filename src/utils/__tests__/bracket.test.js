import { describe, expect, it } from 'vitest';
import {
  bracketIndex, buildBracket, drawOrder, isFinalRound, nextPosition, roundCount, roundName
} from '../bracket.js';

const ids = (n) => Array.from({ length: n }, (_, i) => `p${i}`);

describe('cuadro de torneo', () => {
  it('cantidad de rondas y llaves', () => {
    expect(roundCount(4)).toBe(2);
    expect(roundCount(8)).toBe(3);
    expect(buildBracket(ids(4))).toHaveLength(3); // 2 semis + final
    expect(buildBracket(ids(8))).toHaveLength(7); // 4 cuartos + 2 semis + final
  });

  it('cada jugador queda en una sola llave de la primera ronda', () => {
    for (const size of [4, 8]) {
      const bracket = buildBracket(ids(size));
      const firstRound = bracket.filter((m) => m.round === 0).flatMap((m) => m.players);
      expect(new Set(firstRound).size).toBe(size);
      expect(firstRound.sort()).toEqual(ids(size).sort());
      expect(bracket.filter((m) => m.round > 0).every((m) => m.players.every((p) => p === null))).toBe(true);
    }
  });

  it('el índice plano coincide con el orden del cuadro', () => {
    for (const size of [4, 8]) {
      const bracket = buildBracket(ids(size));
      bracket.forEach((m, i) => expect(bracketIndex(size, m.round, m.slot)).toBe(i));
    }
  });

  it('el ganador avanza a la llave y posición correctas', () => {
    expect(nextPosition(8, 0, 0)).toEqual({ round: 1, slot: 0, position: 0 });
    expect(nextPosition(8, 0, 3)).toEqual({ round: 1, slot: 1, position: 1 });
    expect(nextPosition(8, 1, 1)).toEqual({ round: 2, slot: 0, position: 1 });
    expect(nextPosition(8, 2, 0)).toBeNull();
    expect(nextPosition(4, 0, 1)).toEqual({ round: 1, slot: 0, position: 1 });
    expect(isFinalRound(4, 1)).toBe(true);
  });

  it('el sorteo usa el generador que recibe (por defecto crypto.randomInt) y produce una permutación', () => {
    const calls = [];
    const rand = (n) => { calls.push(n); return 0; };
    const order = drawOrder(ids(8), rand);
    expect(calls).toEqual([8, 7, 6, 5, 4, 3, 2]);
    expect([...order].sort()).toEqual(ids(8).sort());
    // Con el generador real, distintos sorteos dan órdenes distintos alguna vez
    const seen = new Set(Array.from({ length: 30 }, () => drawOrder(ids(8)).join()));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('nombres de las rondas', () => {
    expect([0, 1, 2].map((r) => roundName(8, r))).toEqual(['Cuartos de final', 'Semifinal', 'Final']);
    expect([0, 1].map((r) => roundName(4, r))).toEqual(['Semifinal', 'Final']);
  });
});
