import { RuleError } from './errors.js';

export const PHASES = {
  HAND_OVER: 'hand_over', // esperando el próximo reparto (también al crear la partida)
  PLAYING: 'playing',
  FINISHED: 'finished'
};

export const TARGET_POINTS = [15, 30];

/**
 * Estado inicial de una partida. Los jugadores se sientan en el orden recibido y los equipos
 * alternan por asiento (0, 1, 0, 1), así el motor ya soporta 2 vs 2 aunque la UI sea 1 vs 1.
 * `dealerSeat` es quien reparte la primera mano (lo sortea matchService).
 */
export function createMatchState({ config, playerIds, dealerSeat = 0 }) {
  const { targetPoints, withFlor = false } = config || {};
  if (!TARGET_POINTS.includes(targetPoints)) {
    throw new RuleError('INVALID_CONFIG', 'La partida tiene que ser a 15 o 30 puntos');
  }
  if (withFlor) {
    throw new RuleError('FLOR_NOT_SUPPORTED', 'La flor todavía no está disponible');
  }
  if (![2, 4].includes(playerIds?.length) || new Set(playerIds).size !== playerIds.length) {
    throw new RuleError('INVALID_CONFIG', 'La partida necesita 2 o 4 jugadores distintos');
  }
  const n = playerIds.length;
  if (!Number.isInteger(dealerSeat) || dealerSeat < 0 || dealerSeat >= n) {
    throw new RuleError('INVALID_CONFIG', 'Asiento de reparto inválido');
  }

  return {
    config: { targetPoints, withFlor: false },
    players: playerIds.map((id, seat) => ({ id: String(id), seat, team: seat % 2 })),
    score: [0, 0],
    phase: PHASES.HAND_OVER,
    winnerTeam: null,
    endReason: null,
    handNumber: 0,
    // El próximo reparto rota al asiento siguiente: arrancamos "uno antes" del primer repartidor
    lastDealerSeat: (dealerSeat - 1 + n) % n,
    hand: null
  };
}
