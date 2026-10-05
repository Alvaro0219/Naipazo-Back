import { shuffleDeck } from '../deck.js';
import { applyAction, dealNextHand, getAvailableActions } from '../engine.js';
import { PHASES, createMatchState } from '../state.js';

/**
 * Juega una partida completa entre bots que eligen acciones legales al azar.
 * `onStep(state)` se llama después de cada cambio de estado (para verificar invariantes).
 */
export function simulateMatch({ targetPoints, rng, players = 2, onStep = () => {}, maxSteps = 40000 }) {
  let state = createMatchState({
    config: { targetPoints },
    playerIds: Array.from({ length: players }, (_, i) => `P${i + 1}`),
    dealerSeat: rng(players)
  });
  const actions = [];

  for (let step = 0; step < maxSteps; step++) {
    if (state.phase === PHASES.FINISHED) return { state, actions };

    if (state.phase === PHASES.HAND_OVER) {
      state = dealNextHand(state, shuffleDeck(undefined, rng)).state;
      onStep(state);
      continue;
    }

    const options = state.players.flatMap((p) => getAvailableActions(state, p.id).flatMap((type) => (
      type === 'PLAY_CARD'
        ? state.hand.cards[p.id].map((cardId) => ({ playerId: p.id, action: { type, payload: { cardId } } }))
        : [{ playerId: p.id, action: { type } }]
    )));
    if (options.length === 0) throw new Error('Nadie puede actuar y la partida no terminó');

    const actors = new Set(options.map((o) => o.playerId));
    if (actors.size !== 1) throw new Error('Más de un jugador puede actuar a la vez');

    // Irse al mazo con menos probabilidad, para que las partidas tengan manos jugadas
    const weighted = options.filter((o) => o.action.type !== 'GO_TO_DECK' || rng(10) === 0);
    const choice = (weighted.length ? weighted : options)[rng(weighted.length || options.length)];
    actions.push(choice);
    state = applyAction(state, choice.playerId, choice.action).state;
    onStep(state);
  }
  throw new Error('La partida no terminó dentro del límite de pasos');
}
