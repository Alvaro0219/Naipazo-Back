// Baraja española de 40 cartas (sin 8, 9 ni comodines). Una carta se identifica como "numero-palo".

export const SUITS = ['espada', 'basto', 'oro', 'copa'];
export const NUMBERS = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12];

export function cardId(number, suit) {
  return `${number}-${suit}`;
}

export const ALL_CARD_IDS = SUITS.flatMap((suit) => NUMBERS.map((n) => cardId(n, suit)));
const VALID_IDS = new Set(ALL_CARD_IDS);

export function isValidCardId(id) {
  return VALID_IDS.has(id);
}

export function parseCard(id) {
  if (!VALID_IDS.has(id)) throw new Error(`Carta inválida: ${id}`);
  const [number, suit] = id.split('-');
  return { id, number: Number(number), suit };
}

// Jerarquía del truco: mayor número = carta más alta.
const SPECIAL_RANKS = { '1-espada': 14, '1-basto': 13, '7-espada': 12, '7-oro': 11 };
const RANK_BY_NUMBER = { 3: 10, 2: 9, 1: 8, 12: 7, 11: 6, 10: 5, 7: 4, 6: 3, 5: 2, 4: 1 };

export function trucoRank(id) {
  return SPECIAL_RANKS[id] ?? RANK_BY_NUMBER[parseCard(id).number];
}

/** Valor de la carta para el envido: las figuras (10, 11, 12) valen 0. */
export function envidoValue(id) {
  const { number } = parseCard(id);
  return number >= 10 ? 0 : number;
}
