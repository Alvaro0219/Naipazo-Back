import { randomInt } from 'node:crypto';

// Cuadro de eliminación directa (torneos de 4 u 8 jugadores), como lista plana ordenada por ronda:
//   8 jugadores: ronda 0 = cuartos (llaves 0–3), ronda 1 = semifinales (0–1), ronda 2 = final (0).
//   4 jugadores: ronda 0 = semifinales, ronda 1 = final.
// El ganador de (ronda r, llave s) pasa a (r + 1, s >> 1), en la posición s & 1.

/** Cantidad de rondas: log2 del tamaño (4 → 2, 8 → 3). */
export function roundCount(size) {
  return Math.log2(size);
}

/** Índice en la lista plana de la llave (round, slot). */
export function bracketIndex(size, round, slot) {
  let offset = 0;
  for (let r = 0; r < round; r++) offset += size / 2 ** (r + 1);
  return offset + slot;
}

export function isFinalRound(size, round) {
  return round === roundCount(size) - 1;
}

/** Hacia dónde avanza el ganador de una llave, o null si era la final. */
export function nextPosition(size, round, slot) {
  if (isFinalRound(size, round)) return null;
  return { round: round + 1, slot: slot >> 1, position: slot & 1 };
}

/** Fisher-Yates con crypto.randomInt (nunca Math.random). Devuelve una copia mezclada. */
export function drawOrder(items, rand = randomInt) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Sorteo del cuadro: mezcla a los jugadores y arma todas las llaves. La primera ronda queda con sus
 * parejas; las siguientes, vacías hasta que se definan los ganadores.
 */
export function buildBracket(playerIds, rand = randomInt) {
  const size = playerIds.length;
  if (![4, 8].includes(size)) throw new Error(`Tamaño de torneo inválido: ${size}`);
  const order = drawOrder(playerIds, rand);
  const bracket = [];
  for (let round = 0; round < roundCount(size); round++) {
    const slots = size / 2 ** (round + 1);
    for (let slot = 0; slot < slots; slot++) {
      bracket.push({
        round,
        slot,
        players: round === 0 ? [order[slot * 2], order[slot * 2 + 1]] : [null, null],
        status: round === 0 ? 'ready' : 'pending'
      });
    }
  }
  return bracket;
}

/** Nombre de la ronda para los textos: "Cuartos de final", "Semifinal", "Final". */
export function roundName(size, round) {
  const fromEnd = roundCount(size) - 1 - round;
  return ['Final', 'Semifinal', 'Cuartos de final'][fromEnd] || `Ronda ${round + 1}`;
}
