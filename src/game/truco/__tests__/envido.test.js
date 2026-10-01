import { describe, expect, it } from 'vitest';
import {
  canRaiseEnvido, computeTantos, envidoAcceptedPoints, envidoRejectedPoints
} from '../envido.js';

describe('computeTantos', () => {
  it.each([
    ['dos del mismo palo', ['7-espada', '6-espada', '3-oro'], 33],
    ['dos del mismo palo con figura', ['7-espada', '12-espada', '3-oro'], 27],
    ['dos figuras del mismo palo', ['10-copa', '11-copa', '4-oro'], 20],
    ['tres del mismo palo: suman las dos más altas', ['7-oro', '6-oro', '5-oro'], 33],
    ['tres del mismo palo con figura', ['12-basto', '1-basto', '4-basto'], 25],
    ['ninguno del mismo palo: la más alta', ['7-espada', '3-oro', '12-copa'], 7],
    ['ninguno del mismo palo, todas figuras', ['10-espada', '11-oro', '12-copa'], 0],
    ['el par gana aunque haya una carta suelta mayor', ['1-copa', '2-copa', '7-oro'], 23],
    ['máximo posible', ['7-copa', '6-copa', '1-oro'], 33]
  ])('%s', (_, cards, expected) => {
    expect(computeTantos(cards)).toBe(expected);
  });
});

describe('secuencias de envido', () => {
  it('permite las subidas estándar', () => {
    expect(canRaiseEnvido(['ENVIDO'], 'ENVIDO')).toBe(true);
    expect(canRaiseEnvido(['ENVIDO', 'ENVIDO'], 'ENVIDO')).toBe(false);
    expect(canRaiseEnvido(['ENVIDO', 'ENVIDO'], 'REAL_ENVIDO')).toBe(true);
    expect(canRaiseEnvido(['REAL_ENVIDO'], 'ENVIDO')).toBe(false);
    expect(canRaiseEnvido(['REAL_ENVIDO'], 'REAL_ENVIDO')).toBe(false);
    expect(canRaiseEnvido(['REAL_ENVIDO'], 'FALTA_ENVIDO')).toBe(true);
    expect(canRaiseEnvido(['FALTA_ENVIDO'], 'FALTA_ENVIDO')).toBe(false);
  });

  it.each([
    [['ENVIDO'], 2, 1],
    [['REAL_ENVIDO'], 3, 1],
    [['FALTA_ENVIDO'], 'falta', 1],
    [['ENVIDO', 'ENVIDO'], 4, 2],
    [['ENVIDO', 'REAL_ENVIDO'], 5, 2],
    [['ENVIDO', 'ENVIDO', 'REAL_ENVIDO'], 7, 4],
    [['ENVIDO', 'FALTA_ENVIDO'], 'falta', 2],
    [['ENVIDO', 'ENVIDO', 'REAL_ENVIDO', 'FALTA_ENVIDO'], 'falta', 7]
  ])('%j: quiero = %s, no quiero = %i', (calls, accepted, rejected) => {
    expect(envidoAcceptedPoints(calls, 99)).toBe(accepted === 'falta' ? 99 : accepted);
    expect(envidoRejectedPoints(calls)).toBe(rejected);
  });
});
