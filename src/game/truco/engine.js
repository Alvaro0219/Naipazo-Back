import { isValidCardId } from './cards.js';
import { RuleError } from './errors.js';
import {
  canRaiseEnvido, computeTantos, envidoAcceptedPoints, envidoRejectedPoints
} from './envido.js';
import { bazaWinner, decideHandWinner, faltaEnvidoPoints } from './scoring.js';
import { PHASES } from './state.js';

// Motor puro: applyAction(state, playerId, action) -> { state, events } | throws RuleError.
// Nunca muta el estado recibido. Sin base de datos, sockets ni reloj: la aleatoriedad entra
// solo por el mazo que se le pasa a dealNextHand, y los timers viven en matchService.

const TRUCO_CALLS = { CALL_TRUCO: 2, CALL_RETRUCO: 3, CALL_VALE_CUATRO: 4 };
export const TRUCO_NAMES = { 2: 'TRUCO', 3: 'RETRUCO', 4: 'VALE_CUATRO' };
const ENVIDO_ACTIONS = {
  CALL_ENVIDO: 'ENVIDO',
  CALL_REAL_ENVIDO: 'REAL_ENVIDO',
  CALL_FALTA_ENVIDO: 'FALTA_ENVIDO'
};

export const ACTION_TYPES = [
  'PLAY_CARD',
  ...Object.keys(TRUCO_CALLS),
  ...Object.keys(ENVIDO_ACTIONS),
  'ACCEPT',
  'REJECT',
  'GO_TO_DECK'
];

// Variante elegida: irse al mazo en la primera baza, cuando todavía se podía cantar envido,
// le da al rival 1 punto extra por el envido.
const DECK_IN_FIRST_BAZA_ENVIDO_BONUS = 1;

// ─── Helpers ───────────────────────────────────────────────

const findPlayer = (state, id) => state.players.find((p) => p.id === String(id));
const nextSeat = (state, seat) => (seat + 1) % state.players.length;
const otherTeam = (team) => 1 - team;
const manoTeamOf = (state) => state.players[state.hand.manoSeat].team;
const currentBaza = (hand) => hand.bazas[hand.bazas.length - 1];

/** Asientos en el orden de juego de la baza en curso (desde quien la abrió). */
function bazaOrder(state) {
  const n = state.players.length;
  const leader = currentBaza(state.hand).leaderSeat;
  return Array.from({ length: n }, (_, k) => (leader + k) % n);
}

/**
 * Quién responde un canto: uno solo de los rivales, el más mano (el que juega antes en la baza en curso).
 * En 1 vs 1 es siempre el único rival.
 */
function responderSeatFor(state, callerTeam) {
  return bazaOrder(state).find((seat) => state.players[seat].team !== callerTeam);
}

/**
 * En 2 vs 2 el envido lo cantan solo los pies: el último de cada pareja en la primera baza
 * (el compañero del mano y el que reparte). En 1 vs 1 lo canta cualquiera en su turno.
 */
function isPie(state, seat) {
  const n = state.players.length;
  if (n === 2) return true;
  const { manoSeat } = state.hand;
  return seat === (manoSeat + 2) % n || seat === (manoSeat + 3) % n;
}

/** El envido solo se canta en la primera baza, una vez por mano y antes de que se quiera el truco. */
function envidoWindowOpen(hand) {
  return hand.envido.status === 'none' && hand.bazas.length === 1 && hand.truco.level === 1;
}

// ─── Validación (única fuente de verdad, también para availableActions) ──

function check(state, playerId, type, payload = {}) {
  if (state.phase === PHASES.FINISHED) throw new RuleError('MATCH_FINISHED', 'La partida terminó');
  const me = findPlayer(state, playerId);
  if (!me) throw new RuleError('NOT_A_PLAYER', 'No sos parte de esta partida');
  if (state.phase !== PHASES.PLAYING) throw new RuleError('HAND_OVER', 'La mano terminó');

  const { hand } = state;
  const { pending } = hand;
  const onTurn = !pending && hand.turnSeat === me.seat;
  // Un canto lo responde un solo jugador: el rival más mano (pending.responderSeat)
  const responding = Boolean(pending) && me.seat === pending.responderSeat;
  const notAllowed = () => new RuleError('ACTION_NOT_ALLOWED', 'No podés hacer eso ahora');

  if (type === 'PLAY_CARD') {
    if (!onTurn) throw new RuleError('NOT_YOUR_TURN', pending ? 'Hay un canto esperando respuesta' : 'No es tu turno');
    if (!hand.cards[me.id].includes(payload.cardId)) throw new RuleError('CARD_NOT_IN_HAND', 'No tenés esa carta');
    return;
  }

  if (type in TRUCO_CALLS) {
    const level = TRUCO_CALLS[type];
    if (onTurn) {
      // Truco lo canta cualquiera; las subidas solo quien tiene el quiero
      const holderOk = hand.truco.holderTeam === null || hand.truco.holderTeam === me.team;
      if (hand.truco.level === level - 1 && holderOk) return;
    } else if (responding && pending.kind === 'truco' && pending.level === level - 1) {
      return; // responder subiendo (retruco / vale cuatro)
    }
    throw notAllowed();
  }

  if (type in ENVIDO_ACTIONS) {
    const call = ENVIDO_ACTIONS[type];
    if (onTurn && envidoWindowOpen(hand) && isPie(state, me.seat)) return;
    if (responding && pending.kind === 'envido' && canRaiseEnvido(hand.envido.calls, call)) return;
    // "El envido está primero": quien responde un truco (todavía no querido) puede cantar envido, sea pie o no
    if (responding && pending.kind === 'truco' && pending.level === 2 && envidoWindowOpen(hand)) return;
    throw notAllowed();
  }

  if (type === 'ACCEPT' || type === 'REJECT') {
    if (!pending) throw new RuleError('NOTHING_TO_ANSWER', 'No hay ningún canto para responder');
    // Hay un canto, pero lo responde otro (el que cantó, su compañero o el compañero del que responde)
    if (!responding) throw new RuleError('NOT_YOUR_TURN', 'Este canto lo responde otro jugador');
    return;
  }

  if (type === 'GO_TO_DECK') {
    if (onTurn || responding) return;
    throw new RuleError('NOT_YOUR_TURN', 'No es tu turno');
  }

  throw new RuleError('UNKNOWN_ACTION', 'Acción desconocida');
}

// ─── Puntos y cierre de mano / partida ─────────────────────

/** Suma puntos y termina la partida si se alcanzó el objetivo. Devuelve true si terminó. */
function award(state, events, team, points, reason) {
  const target = state.config.targetPoints;
  state.score[team] = Math.min(target, state.score[team] + points);
  events.push({ type: 'POINTS', team, points, reason, score: [...state.score] });
  if (state.score[team] >= target) {
    state.phase = PHASES.FINISHED;
    state.winnerTeam = team;
    state.endReason = 'normal';
    if (state.hand) state.hand.pending = null;
    events.push({ type: 'MATCH_FINISHED', winnerTeam: team, score: [...state.score], reason: 'normal' });
    return true;
  }
  return false;
}

function endHand(state, events, winnerTeam, points, reason) {
  const { hand } = state;
  hand.pending = null;
  hand.result = { winnerTeam, points, reason };
  events.push({ type: 'HAND_WON', winnerTeam, points, reason });
  if (!award(state, events, winnerTeam, points, reason)) state.phase = PHASES.HAND_OVER;
}

function resolveBaza(state, events) {
  const { hand } = state;
  const baza = currentBaza(hand);
  const { winnerTeam, winnerPlayerId } = bazaWinner(baza.plays.map((p) => ({ ...p, team: findPlayer(state, p.playerId).team })));
  baza.winnerTeam = winnerTeam;
  events.push({ type: 'BAZA_WON', bazaIndex: hand.bazas.length - 1, winnerTeam, winnerPlayerId });

  const handWinner = decideHandWinner(hand.bazas.map((b) => b.winnerTeam), manoTeamOf(state));
  if (handWinner !== undefined) {
    endHand(state, events, handWinner, hand.truco.level, 'bazas');
    return;
  }

  // Quien gana la baza juega primero en la siguiente; con parda, el mano
  hand.turnSeat = winnerPlayerId === null ? hand.manoSeat : findPlayer(state, winnerPlayerId).seat;
  hand.bazas.push({ plays: [], winnerTeam: undefined, leaderSeat: hand.turnSeat });
}

/**
 * Canto de los tantos: empieza el mano y sigue en orden de asiento. Cada jugador solo canta sus tantos
 * si su equipo va perdiendo y los supera (el empate lo gana el mano, que ya cantó); si no, dice
 * "son buenas" y sus tantos no se revelan. Devuelve los tantos cantados (en orden) y el ganador.
 */
function announceTantos(state) {
  const { hand } = state;
  const n = state.players.length;
  const tantos = {};
  let best = null; // { team, value }

  for (let k = 0; k < n; k++) {
    const player = state.players[(hand.manoSeat + k) % n];
    const value = computeTantos(hand.dealt[player.id]);
    if (best === null || (player.team !== best.team && value > best.value)) {
      tantos[player.id] = value;
      best = { team: player.team, value };
    }
  }
  return { tantos, winnerTeam: best.team };
}

function resolveEnvido(state, events, accepted) {
  const { hand } = state;
  const { pending } = hand;
  const { calls } = hand.envido;
  let winnerTeam;
  let points;

  if (accepted) {
    const { tantos, winnerTeam: winner } = announceTantos(state);
    winnerTeam = winner;
    points = envidoAcceptedPoints(calls, faltaEnvidoPoints(state.score, state.config.targetPoints));
    // `tantos` solo trae los que se cantaron: los de quien dijo "son buenas" quedan ocultos
    hand.envido.result = { accepted: true, tantos, winnerTeam, points };
    events.push({ type: 'ENVIDO_RESULT', accepted: true, tantos, winnerTeam, points });
  } else {
    winnerTeam = pending.callerTeam;
    points = envidoRejectedPoints(calls);
    hand.envido.result = { accepted: false, tantos: null, winnerTeam, points };
    events.push({ type: 'ENVIDO_RESULT', accepted: false, winnerTeam, points });
  }

  hand.envido.status = 'done';
  // Si el envido interrumpió un truco ("el envido está primero"), el truco vuelve a quedar pendiente
  hand.pending = pending.deferredTruco || null;
  award(state, events, winnerTeam, points, 'envido');
}

// ─── API pública ───────────────────────────────────────────

export function dealNextHand(state, deck) {
  if (state.phase === PHASES.FINISHED) throw new RuleError('MATCH_FINISHED', 'La partida terminó');
  if (state.phase === PHASES.PLAYING) throw new RuleError('HAND_IN_PROGRESS', 'La mano todavía no terminó');
  if (!Array.isArray(deck) || deck.length !== 40 || new Set(deck).size !== 40 || !deck.every(isValidCardId)) {
    throw new RuleError('INVALID_DECK', 'Mazo inválido');
  }

  const s = structuredClone(state);
  const n = s.players.length;
  const dealerSeat = nextSeat(s, s.lastDealerSeat);
  const manoSeat = nextSeat(s, dealerSeat);

  // Se reparte de a una carta empezando por el mano
  const cards = Object.fromEntries(s.players.map((p) => [p.id, []]));
  let idx = 0;
  for (let round = 0; round < 3; round++) {
    for (let k = 0; k < n; k++) cards[s.players[(manoSeat + k) % n].id].push(deck[idx++]);
  }

  s.handNumber += 1;
  s.lastDealerSeat = dealerSeat;
  s.phase = PHASES.PLAYING;
  s.hand = {
    number: s.handNumber,
    dealerSeat,
    manoSeat,
    deck: [...deck], // mazo barajado completo, para el MatchHandLog. Nunca se proyecta.
    dealt: structuredClone(cards),
    cards,
    bazas: [{ plays: [], winnerTeam: undefined, leaderSeat: manoSeat }],
    turnSeat: manoSeat,
    truco: { level: 1, holderTeam: null },
    envido: { status: 'none', calls: [], result: null },
    pending: null,
    result: null
  };

  const events = [{
    type: 'HAND_STARTED',
    handNumber: s.handNumber,
    manoId: s.players[manoSeat].id,
    dealerId: s.players[dealerSeat].id
  }];
  return { state: s, events };
}

export function applyAction(state, playerId, action) {
  const { type, payload = {} } = action || {};
  check(state, playerId, type, payload);

  const s = structuredClone(state);
  const events = [];
  const me = findPlayer(s, playerId);
  const { hand } = s;

  if (type === 'PLAY_CARD') {
    hand.cards[me.id] = hand.cards[me.id].filter((c) => c !== payload.cardId);
    const baza = currentBaza(hand);
    baza.plays.push({ playerId: me.id, cardId: payload.cardId });
    events.push({ type: 'CARD_PLAYED', playerId: me.id, cardId: payload.cardId, bazaIndex: hand.bazas.length - 1 });
    if (baza.plays.length < s.players.length) hand.turnSeat = nextSeat(s, me.seat);
    else resolveBaza(s, events);
  } else if (type in TRUCO_CALLS) {
    const level = TRUCO_CALLS[type];
    // Subir implica querer el nivel anterior
    hand.truco.level = level - 1;
    hand.pending = { kind: 'truco', level, callerTeam: me.team, callerId: me.id, responderSeat: responderSeatFor(s, me.team) };
    events.push({ type: 'CALL', playerId: me.id, call: TRUCO_NAMES[level] });
  } else if (type in ENVIDO_ACTIONS) {
    const call = ENVIDO_ACTIONS[type];
    const deferredTruco = hand.pending?.kind === 'truco'
      ? hand.pending
      : (hand.pending?.deferredTruco || null);
    hand.pending = {
      kind: 'envido', callerTeam: me.team, callerId: me.id, responderSeat: responderSeatFor(s, me.team), deferredTruco
    };
    hand.envido.status = 'calling';
    hand.envido.calls.push(call);
    events.push({ type: 'CALL', playerId: me.id, call });
  } else if (type === 'ACCEPT') {
    events.push({ type: 'RESPONSE', playerId: me.id, response: 'QUIERO' });
    if (hand.pending.kind === 'truco') {
      hand.truco.level = hand.pending.level;
      hand.truco.holderTeam = me.team;
      hand.pending = null;
    } else {
      resolveEnvido(s, events, true);
    }
  } else if (type === 'REJECT') {
    events.push({ type: 'RESPONSE', playerId: me.id, response: 'NO_QUIERO' });
    if (hand.pending.kind === 'truco') {
      endHand(s, events, hand.pending.callerTeam, hand.pending.level - 1, 'truco_rejected');
    } else {
      resolveEnvido(s, events, false);
    }
  } else if (type === 'GO_TO_DECK') {
    const bonus = envidoWindowOpen(hand) ? DECK_IN_FIRST_BAZA_ENVIDO_BONUS : 0;
    events.push({ type: 'WENT_TO_DECK', playerId: me.id });
    // Irse al mazo con un envido pendiente equivale a no quererlo
    if (hand.pending?.kind === 'envido') {
      resolveEnvido(s, events, false);
      if (s.phase === PHASES.FINISHED) return { state: s, events };
    }
    endHand(s, events, otherTeam(me.team), hand.truco.level + bonus, 'deck');
  }

  return { state: s, events };
}

/**
 * Vencimiento del tiempo de turno (lo dispara matchService):
 * con un canto pendiente se interpreta como "no quiero"; si había que jugar, se pierde la mano.
 */
export function applyTimeout(state) {
  if (state.phase !== PHASES.PLAYING) throw new RuleError('HAND_OVER', 'No hay ninguna mano en juego');
  const { hand } = state;

  if (hand.pending) {
    const responder = state.players[hand.pending.responderSeat];
    const result = applyAction(state, responder.id, { type: 'REJECT' });
    result.events.unshift({ type: 'TURN_TIMEOUT', playerId: responder.id });
    return { ...result, playerId: responder.id };
  }

  const s = structuredClone(state);
  const player = s.players[s.hand.turnSeat];
  const events = [{ type: 'TURN_TIMEOUT', playerId: player.id }];
  endHand(s, events, otherTeam(player.team), s.hand.truco.level, 'timeout');
  return { state: s, events, playerId: player.id };
}

/** Termina la partida dando ganador al otro equipo (abandono). */
export function forfeitMatch(state, losingTeam, reason = 'abandon') {
  if (state.phase === PHASES.FINISHED) throw new RuleError('MATCH_FINISHED', 'La partida terminó');
  const s = structuredClone(state);
  s.phase = PHASES.FINISHED;
  s.winnerTeam = otherTeam(losingTeam);
  s.endReason = reason;
  if (s.hand) s.hand.pending = null;
  return {
    state: s,
    events: [{ type: 'MATCH_FINISHED', winnerTeam: s.winnerTeam, score: [...s.score], reason }]
  };
}

/** Tipos de acción que `playerId` puede hacer ahora. El front solo muestra estos botones. */
export function getAvailableActions(state, playerId) {
  return ACTION_TYPES.filter((type) => {
    const payload = type === 'PLAY_CARD' ? { cardId: state.hand?.cards?.[String(playerId)]?.[0] } : {};
    try {
      check(state, playerId, type, payload);
      return true;
    } catch {
      return false;
    }
  });
}

/** Jugadores que pueden actuar ahora (el del turno, o quienes deben responder un canto). */
export function getActingPlayerIds(state) {
  return state.players.filter((p) => getAvailableActions(state, p.id).length > 0).map((p) => p.id);
}
