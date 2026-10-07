import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_CARD_IDS, envidoValue, parseCard, trucoRank } from '../cards.js';
import { createDeck, shuffleDeck } from '../deck.js';
import { seededRng } from './helpers.js';

describe('cartas', () => {
  it('R-MAZO-01: el mazo tiene 40 cartas únicas, sin 8 ni 9', () => {
    expect(ALL_CARD_IDS).toHaveLength(40);
    expect(new Set(ALL_CARD_IDS).size).toBe(40);
    expect(ALL_CARD_IDS.some((c) => /^(8|9)-/.test(c))).toBe(false);
  });

  it('rechaza cartas inválidas', () => {
    expect(() => parseCard('8-oro')).toThrow();
    expect(() => parseCard('1-corazon')).toThrow();
  });

  it('R-CARTA-01: respeta la jerarquía completa del truco', () => {
    const order = [
      ['1-espada'], ['1-basto'], ['7-espada'], ['7-oro'],
      ['3-espada', '3-basto', '3-oro', '3-copa'],
      ['2-espada', '2-basto', '2-oro', '2-copa'],
      ['1-copa', '1-oro'],
      ['12-espada', '12-basto', '12-oro', '12-copa'],
      ['11-espada', '11-basto', '11-oro', '11-copa'],
      ['10-espada', '10-basto', '10-oro', '10-copa'],
      ['7-copa', '7-basto'],
      ['6-espada', '6-basto', '6-oro', '6-copa'],
      ['5-espada', '5-basto', '5-oro', '5-copa'],
      ['4-espada', '4-basto', '4-oro', '4-copa']
    ];
    expect(order.flat().sort()).toEqual([...ALL_CARD_IDS].sort());
    order.forEach((group, i) => {
      const ranks = group.map(trucoRank);
      expect(new Set(ranks).size).toBe(1); // las del mismo grupo empatan
      if (i > 0) expect(trucoRank(order[i - 1][0])).toBeGreaterThan(ranks[0]);
    });
  });

  it('las figuras valen 0 para el envido', () => {
    expect(envidoValue('10-oro')).toBe(0);
    expect(envidoValue('11-copa')).toBe(0);
    expect(envidoValue('12-espada')).toBe(0);
    expect(envidoValue('7-basto')).toBe(7);
  });
});

describe('mazo', () => {
  it('R-MAZO-02: barajar devuelve una permutación sin modificar el original', () => {
    const deck = createDeck();
    const shuffled = shuffleDeck(deck);
    expect(deck).toEqual(ALL_CARD_IDS);
    expect([...shuffled].sort()).toEqual([...ALL_CARD_IDS].sort());
  });

  it('con la misma fuente aleatoria el resultado es reproducible', () => {
    expect(shuffleDeck(createDeck(), seededRng(7))).toEqual(shuffleDeck(createDeck(), seededRng(7)));
    expect(shuffleDeck(createDeck(), seededRng(7))).not.toEqual(shuffleDeck(createDeck(), seededRng(8)));
  });

  it('R-MAZO-02: el motor nunca usa Math.random', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      const code = readFileSync(join(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/Math\.random/);
    }
  });
});
