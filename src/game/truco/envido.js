import { envidoValue, parseCard } from './cards.js';

export const ENVIDO_CALLS = ['ENVIDO', 'REAL_ENVIDO', 'FALTA_ENVIDO'];
const CALL_POINTS = { ENVIDO: 2, REAL_ENVIDO: 3 };

/**
 * Tantos de una mano: con dos o más cartas del mismo palo, 20 + las dos más altas;
 * si no hay dos del mismo palo, la carta de mayor valor. Las figuras valen 0.
 * (Sin flor, tres cartas del mismo palo cuentan como envido con las dos más altas.)
 */
export function computeTantos(cardIds) {
  const bySuit = {};
  for (const id of cardIds) {
    const { suit } = parseCard(id);
    (bySuit[suit] ||= []).push(envidoValue(id));
  }
  let best = 0;
  for (const values of Object.values(bySuit)) {
    values.sort((a, b) => b - a);
    best = Math.max(best, values.length >= 2 ? 20 + values[0] + values[1] : values[0]);
  }
  return best;
}

/**
 * ¿Se puede cantar `next` después de la secuencia `calls`?
 * Envido hasta dos veces, real envido una vez (y no se vuelve a envido después),
 * falta envido cierra la secuencia.
 */
export function canRaiseEnvido(calls, next) {
  if (calls.includes('FALTA_ENVIDO')) return false;
  if (next === 'FALTA_ENVIDO') return true;
  if (next === 'REAL_ENVIDO') return !calls.includes('REAL_ENVIDO');
  if (next === 'ENVIDO') {
    return !calls.includes('REAL_ENVIDO') && calls.filter((c) => c === 'ENVIDO').length < 2;
  }
  return false;
}

/** Puntos si se acepta la secuencia. La falta envido reemplaza a lo cantado antes. */
export function envidoAcceptedPoints(calls, faltaPoints) {
  if (calls.includes('FALTA_ENVIDO')) return faltaPoints;
  return calls.reduce((sum, call) => sum + CALL_POINTS[call], 0);
}

/** Puntos para quien cantó si no se acepta: 1, o lo aceptado antes de la última subida. */
export function envidoRejectedPoints(calls) {
  if (calls.length <= 1) return 1;
  // La falta envido siempre es el último canto, así que no aparece en lo anterior
  return envidoAcceptedPoints(calls.slice(0, -1), 0);
}
