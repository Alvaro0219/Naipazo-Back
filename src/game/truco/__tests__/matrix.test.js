// Matriz de cantos, celda por celda: en cada estado, cada jugador puede hacer exactamente lo de la matriz
// (y nada más), y lo que ofrece getAvailableActions es lo que applyAction acepta.
import { describe, expect, it } from 'vitest';
import { ALL_CARD_IDS } from '../cards.js';
import { ACTION_TYPES, applyAction, dealNextHand, getAvailableActions } from '../engine.js';
import { createMatchState } from '../state.js';
import { A, B, makeDeck } from './helpers.js';
import { MATRIX } from './matrix.js';

const HANDS_1V1 = { A: ['4-copa', '5-oro', '6-basto'], B: ['4-espada', '5-copa', '6-oro'] };
const HANDS_2V2 = {
  A1: ['4-copa', '5-oro', '6-basto'],
  B1: ['4-espada', '5-copa', '6-oro'],
  A2: ['4-basto', '5-espada', '6-copa'],
  B2: ['4-oro', '5-basto', '6-espada']
};

function build(row) {
  let state;
  let hands;
  if (row.mode === '1v1') {
    hands = HANDS_1V1;
    state = dealNextHand(createMatchState({ config: { targetPoints: 30 }, playerIds: [A, B], dealerSeat: 1 }), makeDeck(hands.A, hands.B)).state;
  } else {
    hands = HANDS_2V2;
    const order = ['A1', 'B1', 'A2', 'B2'];
    const dealt = [];
    for (let r = 0; r < 3; r++) for (const p of order) dealt.push(hands[p][r]);
    const deck = [...dealt, ...ALL_CARD_IDS.filter((c) => !dealt.includes(c))];
    state = dealNextHand(createMatchState({ config: { targetPoints: 30 }, playerIds: order, dealerSeat: 3 }), deck).state;
  }
  for (const [player, type, cardIndex] of row.steps) {
    const action = type === 'PLAY_CARD' ? { type, payload: { cardId: hands[player][cardIndex] } } : { type };
    state = applyAction(state, player, action).state;
  }
  return state;
}

describe('matriz de cantos', () => {
  for (const row of MATRIX) {
    it(`R-TRUCO-01 / R-ENV-02 / R-ENV-03 / R-TURNO-03 / R-MAZO-IR-02 ${row.id}: ${row.state}`, () => {
      const state = build(row);
      for (const p of state.players) {
        const expected = [...(row.allowed[p.id] || [])].sort();
        expect(getAvailableActions(state, p.id).sort(), `${row.id} ${p.id}`).toEqual(expected);
        // Y lo que no está permitido, el motor lo rechaza
        for (const type of ACTION_TYPES.filter((t) => !expected.includes(t))) {
          const action = type === 'PLAY_CARD' ? { type, payload: { cardId: state.hand.cards[p.id][0] } } : { type };
          expect(() => applyAction(state, p.id, action), `${row.id} ${p.id} ${type}`).toThrow();
        }
      }
    });
  }
});
