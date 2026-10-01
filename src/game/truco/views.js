import { TRUCO_NAMES, getAvailableActions } from './engine.js';
import { RuleError } from './errors.js';
import { scoreSection } from './scoring.js';

/**
 * Lo que `playerId` puede ver de la partida: sus cartas, las cartas ya jugadas, el marcador,
 * los cantos y de quién es el turno. Nunca incluye las cartas del rival ni el mazo, y tampoco
 * ayudas como el cálculo de los propios tantos: cada jugador los cuenta él mismo.
 */
export function projectStateFor(state, playerId) {
  const me = state.players.find((p) => p.id === String(playerId));
  if (!me) throw new RuleError('NOT_A_PLAYER', 'No sos parte de esta partida');
  const { hand } = state;
  const target = state.config.targetPoints;

  return {
    config: { ...state.config },
    phase: state.phase,
    score: [...state.score],
    scoreSections: state.score.map((points) => scoreSection(points, target)),
    winnerTeam: state.winnerTeam,
    endReason: state.endReason,
    handNumber: state.handNumber,
    me: { id: me.id, seat: me.seat, team: me.team },
    players: state.players.map((p) => ({
      id: p.id,
      seat: p.seat,
      team: p.team,
      cardsInHand: hand ? hand.cards[p.id].length : 0
    })),
    hand: hand ? projectHand(state, hand, me) : null,
    availableActions: getAvailableActions(state, me.id)
  };
}

function projectHand(state, hand, me) {
  const { pending } = hand;
  return {
    number: hand.number,
    manoId: state.players[hand.manoSeat].id,
    dealerId: state.players[hand.dealerSeat].id,
    turnPlayerId: state.phase === 'playing' && !pending ? state.players[hand.turnSeat].id : null,
    myCards: [...hand.cards[me.id]],
    bazas: hand.bazas.map((b) => ({
      plays: b.plays.map((p) => ({ playerId: p.playerId, cardId: p.cardId })),
      winnerTeam: b.winnerTeam ?? null,
      finished: b.winnerTeam !== undefined
    })),
    truco: {
      level: hand.truco.level,
      name: TRUCO_NAMES[hand.truco.level] || null,
      holderTeam: hand.truco.holderTeam
    },
    envido: {
      status: hand.envido.status,
      calls: [...hand.envido.calls],
      // Solo los tantos que se cantaron (el que dijo "son buenas" no los revela)
      result: hand.envido.result ? structuredClone(hand.envido.result) : null
    },
    pending: pending
      ? {
        kind: pending.kind,
        call: pending.kind === 'truco' ? TRUCO_NAMES[pending.level] : hand.envido.calls.at(-1),
        callerId: pending.callerId,
        callerTeam: pending.callerTeam,
        trucoWaiting: Boolean(pending.deferredTruco)
      }
      : null,
    result: hand.result ? { ...hand.result } : null
  };
}
