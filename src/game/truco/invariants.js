import { isValidCardId } from './cards.js';
import { getActingPlayerIds } from './engine.js';
import { PHASES } from './state.js';

// Invariantes del estado del motor (EXACTITUD_DEL_JUEGO.md, sección 4). Se verifican después de CADA acción:
// en los tests (siempre) y en producción (matchService congela la partida si alguno falla).
// Devuelven una lista de violaciones; vacía = todo bien. `prev` (el estado anterior) habilita los chequeos
// de que algo no retroceda.

export function checkInvariants(state, prev = null) {
  const v = [];
  const fail = (id, message) => v.push({ id, message });
  const n = state.players.length;
  const target = state.config.targetPoints;

  // I-P1: puntos enteros, entre 0 y el objetivo, y nunca bajan
  state.score.forEach((p, team) => {
    if (!Number.isInteger(p) || p < 0 || p > target) fail('I-P1', `puntaje inválido del equipo ${team}: ${p}`);
    if (prev && p < prev.score[team]) fail('I-P1', `el puntaje del equipo ${team} bajó de ${prev.score[team]} a ${p}`);
  });

  // I-P3 / R-FIN-01 / R-FIN-02: si alguien llegó al objetivo la partida terminó, con un solo ganador
  const reached = state.score.findIndex((p) => p >= target);
  if (reached !== -1 && state.phase !== PHASES.FINISHED) fail('I-P3', 'un equipo llegó al objetivo y la partida sigue');
  if (state.phase === PHASES.FINISHED) {
    if (![0, 1].includes(state.winnerTeam)) fail('R-FIN-02', 'partida terminada sin un ganador');
    if (state.endReason === 'normal' && state.score[state.winnerTeam] !== target) fail('R-FIN-02', 'el ganador no llegó al objetivo');
    if (state.endReason === 'normal' && state.score[1 - state.winnerTeam] >= target) fail('R-FIN-02', 'los dos equipos llegaron al objetivo');
  }

  const { hand } = state;
  if (hand) {
    // I-C1: el mazo de la mano tiene las 40 cartas distintas
    if (!Array.isArray(hand.deck) || hand.deck.length !== 40 || new Set(hand.deck).size !== 40 || !hand.deck.every(isValidCardId)) {
      fail('I-C1', 'el mazo de la mano no tiene 40 cartas distintas');
    }
    // I-C2 / I-C3: cada carta repartida está en un solo lugar (mano de su dueño o jugada por él)
    const played = hand.bazas.flatMap((b) => b.plays);
    for (const p of state.players) {
      const dealt = hand.dealt[p.id] || [];
      if (dealt.length !== 3) fail('R-REP-01', `${p.id} no recibió 3 cartas`);
      const inHand = hand.cards[p.id] || [];
      const mine = played.filter((x) => x.playerId === p.id).map((x) => x.cardId);
      const all = [...inHand, ...mine];
      if (all.length !== 3 || new Set(all).size !== 3 || !all.every((c) => dealt.includes(c))) {
        fail('I-C2', `las cartas de ${p.id} no cuadran con lo repartido`);
      }
    }
    const allDealt = Object.values(hand.dealt).flat();
    if (new Set(allDealt).size !== 3 * n) fail('I-C2', 'hay cartas repetidas entre los jugadores');
    if (allDealt.some((c) => !hand.deck.slice(0, 3 * n).includes(c))) fail('I-C2', 'se repartieron cartas que no salen del mazo');

    // I-C4 / I-C5: una carta por jugador por baza; las bazas cerradas están completas
    hand.bazas.forEach((b, i) => {
      const ids = b.plays.map((x) => x.playerId);
      if (new Set(ids).size !== ids.length) fail('I-C4', `alguien jugó dos cartas en la baza ${i + 1}`);
      if (b.winnerTeam !== undefined && ids.length !== n) fail('I-C5', `la baza ${i + 1} se cerró incompleta`);
    });
    if (hand.bazas.length > 3) fail('I-C4', 'más de tres bazas en la mano');

    // I-T3: el truco va de 1 a 4 y no baja dentro de la mano
    if (![1, 2, 3, 4].includes(hand.truco.level)) fail('I-T3', `nivel de truco inválido: ${hand.truco.level}`);
    if (prev?.hand && prev.hand.number === hand.number && hand.truco.level < prev.hand.truco.level) {
      fail('I-T3', 'el nivel del truco bajó');
    }
    // I-T4: el envido se resuelve una sola vez y solo se canta en la primera baza
    if (hand.envido.status === 'calling' && hand.bazas.length !== 1) fail('I-T4', 'envido cantado fuera de la primera baza');
    if (prev?.hand && prev.hand.number === hand.number && prev.hand.envido.status === 'done' && hand.envido.status !== 'done') {
      fail('I-T4', 'el envido se reabrió');
    }
    // I-T2: un canto pendiente bien formado, con un solo respondedor rival
    if (hand.pending) {
      const responder = state.players[hand.pending.responderSeat];
      if (!responder || responder.team === hand.pending.callerTeam) fail('I-T2', 'el canto pendiente no tiene un respondedor rival');
    }
  }

  // I-T1 / R-TURNO-01: exactamente un actor con la mano en juego (entre manos o terminada nadie puede actuar:
  // el motor rechaza toda acción fuera de una mano, así que eso no hace falta chequearlo acá)
  if (state.phase === PHASES.PLAYING) {
    const actors = getActingPlayerIds(state);
    if (actors.length !== 1) fail('I-T1', `actores esperados: ${actors.length}`);
  }

  return v;
}
