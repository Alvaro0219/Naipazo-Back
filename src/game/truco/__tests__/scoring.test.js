import { describe, expect, it } from 'vitest';
import { decideHandWinner, MALAS_LAST_POINT, faltaEnvidoPoints, scoreSection } from '../scoring.js';

describe('faltaEnvidoPoints', () => {
  it('a 15 puntos vale lo que le falta al líder', () => {
    expect(faltaEnvidoPoints([0, 0], 15)).toBe(15);
    expect(faltaEnvidoPoints([10, 4], 15)).toBe(5);
    expect(faltaEnvidoPoints([3, 14], 15)).toBe(1);
  });

  it('a 30 puntos con el líder en malas cuenta hasta 15', () => {
    expect(faltaEnvidoPoints([0, 0], 30)).toBe(15);
    expect(faltaEnvidoPoints([8, 2], 30)).toBe(7);
    expect(faltaEnvidoPoints([14, 14], 30)).toBe(1);
  });

  it('a 30 puntos con el líder en 15 o más cuenta hasta 30', () => {
    expect(faltaEnvidoPoints([15, 3], 30)).toBe(15);
    expect(faltaEnvidoPoints([20, 25], 30)).toBe(5);
  });
});

describe('scoreSection', () => {
  it('divide en malas (0–15) y buenas (16–30) solo a 30 puntos', () => {
    expect(scoreSection(15, 30)).toBe('malas');
    expect(scoreSection(16, 30)).toBe('buenas');
    expect(scoreSection(10, 15)).toBeNull();
  });
});

describe('frontera de malas y buenas (14, 15 y 16 puntos, a 30)', () => {
  it.each([
    [14, 'malas', 1],
    [15, 'malas', 15],
    [16, 'buenas', 14]
  ])('líder con %i: está en %s y la falta envido vale %i', (leader, section, falta) => {
    expect(scoreSection(leader, 30)).toBe(section);
    expect(faltaEnvidoPoints([leader, 0], 30)).toBe(falta);
    expect(faltaEnvidoPoints([0, leader], 30)).toBe(falta);
  });

  it('la frontera es un solo valor exportado', () => {
    expect(MALAS_LAST_POINT).toBe(15);
  });
});

describe('decideHandWinner (mano = equipo 0)', () => {
  it.each([
    ['una sola baza nunca define', [1], undefined],
    ['gana dos seguidas', [1, 1], 1],
    ['1-1 sigue a la tercera', [0, 1], undefined],
    ['1-1 y gana la tercera', [0, 1, 1], 1],
    ['parda en la primera: define la segunda', [null, 1], 1],
    ['parda en la segunda: gana quien ganó la primera', [1, null], 1],
    ['parda en primera y segunda: define la tercera', [null, null, 1], 1],
    ['1-1 y parda en la tercera: gana quien ganó la primera', [1, 0, null], 1],
    ['tres pardas: gana el mano', [null, null, null], 0],
    ['dos pardas sigue a la tercera', [null, null], undefined]
  ])('%s', (_, results, expected) => {
    expect(decideHandWinner(results, 0)).toBe(expected);
  });
});
