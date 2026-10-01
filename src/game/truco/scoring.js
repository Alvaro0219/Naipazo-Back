/**
 * Valor de la falta envido: lo que le falta al líder del marcador para ganar.
 * A 30 puntos, si el líder está en malas (menos de 15) se cuenta hasta 15; si no, hasta 30.
 */
export function faltaEnvidoPoints(score, targetPoints) {
  const leader = Math.max(...score);
  if (targetPoints === 30 && leader < 15) return 15 - leader;
  return Math.max(1, targetPoints - leader);
}

/** A 30 puntos el marcador se divide en malas (0–15) y buenas (16–30). */
export function scoreSection(points, targetPoints) {
  if (targetPoints !== 30) return null;
  return points > 15 ? 'buenas' : 'malas';
}

/**
 * Ganador de la mano según los resultados de las bazas jugadas (equipo ganador o null si fue parda).
 * Devuelve el equipo ganador, o undefined si la mano sigue.
 *  - Gana quien gane dos bazas.
 *  - Parda en la 1.ª: gana quien gane la 2.ª.
 *  - Parda en la 2.ª (o en la 3.ª): gana quien ganó la 1.ª.
 *  - Tres pardas: gana el equipo del mano.
 */
export function decideHandWinner(results, manoTeam) {
  const wins = [0, 0];
  for (const r of results) if (r !== null) wins[r] += 1;
  if (wins[0] >= 2) return 0;
  if (wins[1] >= 2) return 1;
  if (results.length < 2) return undefined;

  const [first, second, third] = results;
  if (first === null && second !== null) return second;
  if (first !== null && second === null) return first;
  if (results.length < 3) return undefined;

  if (third !== null) return third;
  return first ?? manoTeam;
}
