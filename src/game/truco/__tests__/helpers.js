import { ALL_CARD_IDS } from '../cards.js';
import { applyAction, dealNextHand } from '../engine.js';
import { createMatchState } from '../state.js';

// En todos los escenarios: A (asiento 0, equipo 0) es mano en la primera mano; B (asiento 1, equipo 1) es pie.
export const A = 'A';
export const B = 'B';

/** Mazo que reparte `manoCards` al mano y `pieCards` al pie (se reparte de a una, empezando por el mano). */
export function makeDeck(manoCards, pieCards) {
  const dealt = [];
  for (let i = 0; i < 3; i++) dealt.push(manoCards[i], pieCards[i]);
  return [...dealt, ...ALL_CARD_IDS.filter((c) => !dealt.includes(c))];
}

export function startMatch({ targetPoints = 15, mano, pie, score } = {}) {
  let state = createMatchState({ config: { targetPoints }, playerIds: [A, B], dealerSeat: 1 });
  if (score) state = { ...state, score: [...score] };
  return dealNextHand(state, makeDeck(mano, pie)).state;
}

/**
 * Aplica una secuencia de pasos: [jugador, tipo] o [jugador, 'PLAY_CARD', carta].
 * Devuelve el estado final y todos los eventos acumulados.
 */
export function run(state, steps) {
  const events = [];
  let current = state;
  for (const [playerId, type, cardId] of steps) {
    const action = type === 'PLAY_CARD' ? { type, payload: { cardId } } : { type };
    const result = applyAction(current, playerId, action);
    current = result.state;
    events.push(...result.events);
  }
  return { state: current, events };
}

/** PRNG determinístico (mulberry32) para reproducir mazos y bots en los tests. */
export function seededRng(seed) {
  let t = seed >>> 0;
  const next = () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  return (max) => Math.floor(next() * max);
}
