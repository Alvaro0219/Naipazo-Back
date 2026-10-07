import { trucoRank } from './cards.js';

/**
 * Último punto de las malas en partidas a 30 (*Decisión del dueño*): con 15 se sigue en malas;
 * las buenas empiezan en 16.
 */
export const MALAS_LAST_POINT = 15;

/**
 * Única fuente de verdad de la frontera entre malas y buenas: 'malas' (0–15), 'buenas' (16–30) o null si la
 * partida no es a 30. El front la recibe en el estado proyectado (scoreSections) y no la recalcula.
 */
export function scoreSection(points, targetPoints) {
  if (targetPoints !== 30) return null;
  return points <= MALAS_LAST_POINT ? 'malas' : 'buenas';
}

/**
 * Valor de la falta envido: lo que le falta al líder del marcador para terminar su tramo.
 * A 30 puntos, con el líder en malas se cuenta hasta el final de las malas (15); si el líder ya completó
 * las malas (15 justos, todavía en malas) o está en buenas, se cuenta hasta 30. A 15 puntos, hasta 15.
 */
export function faltaEnvidoPoints(score, targetPoints) {
  const leader = Math.max(...score);
  if (scoreSection(leader, targetPoints) === 'malas' && leader < MALAS_LAST_POINT) return MALAS_LAST_POINT - leader;
  return Math.max(1, targetPoints - leader);
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

/**
 * Ganador de una baza (R-BAZA-01..03). `plays` va en el orden en que se jugaron: [{ playerId, cardId, team }].
 * Gana la carta más alta; empate entre equipos distintos = parda (winnerTeam null); empate entre compañeros = gana
 * su equipo y la baza la "ganó" quien jugó primero de ellos (abre la siguiente).
 */
export function bazaWinner(plays) {
  const ranked = plays.map((p) => ({ ...p, rank: trucoRank(p.cardId) }));
  const top = Math.max(...ranked.map((r) => r.rank));
  const best = ranked.filter((r) => r.rank === top);
  const winnerTeam = new Set(best.map((b) => b.team)).size === 1 ? best[0].team : null;
  return { winnerTeam, winnerPlayerId: winnerTeam === null ? null : best[0].playerId };
}
