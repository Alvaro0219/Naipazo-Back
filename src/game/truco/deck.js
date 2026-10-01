import { randomInt } from 'node:crypto';
import { ALL_CARD_IDS } from './cards.js';

export function createDeck() {
  return [...ALL_CARD_IDS];
}

/**
 * Fisher-Yates con aleatoriedad criptográfica. Prohibido Math.random.
 * `rng(max)` devuelve un entero en [0, max); se inyecta solo en tests para reproducir mazos.
 */
export function shuffleDeck(deck = createDeck(), rng = randomInt) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
