import { describe, expect, it } from 'vitest';
import { PHASES } from '../state.js';
import { seededRng } from './helpers.js';
import { simulateMatch } from './simulation.js';

const MATCHES_PER_CONFIG = 300;
// 300 partidas completas por configuración: es CPU puro y en una máquina cargada pasa los 30 s por defecto
const SIMULATION_TIMEOUT_MS = 120000;

describe('partidas simuladas entre bots aleatorios', () => {
  it.each([15, 30])('a %i puntos siempre terminan sin errores', (targetPoints) => {
    for (let seed = 1; seed <= MATCHES_PER_CONFIG; seed++) {
      let prevScore = [0, 0];
      const { state } = simulateMatch({
        targetPoints,
        rng: seededRng(seed * 7919 + targetPoints),
        onStep: (s) => {
          // El marcador nunca baja ni pasa del objetivo
          s.score.forEach((points, team) => {
            expect(points).toBeGreaterThanOrEqual(prevScore[team]);
            expect(points).toBeLessThanOrEqual(targetPoints);
          });
          prevScore = [...s.score];
          // Cada carta está en exactamente un lugar: en la mano de alguien o jugada
          if (s.hand) {
            const inHands = Object.values(s.hand.cards).flat();
            const played = s.hand.bazas.flatMap((b) => b.plays.map((p) => p.cardId));
            expect(inHands.length + played.length).toBe(6);
            expect(new Set([...inHands, ...played]).size).toBe(6);
          }
        }
      });

      expect(state.phase).toBe(PHASES.FINISHED);
      expect(state.score[state.winnerTeam]).toBe(targetPoints);
      expect(state.score[1 - state.winnerTeam]).toBeLessThan(targetPoints);
    }
  }, SIMULATION_TIMEOUT_MS);

  it('es determinístico: mismo mazo y mismas acciones, mismo resultado', () => {
    const a = simulateMatch({ targetPoints: 30, rng: seededRng(42) });
    const b = simulateMatch({ targetPoints: 30, rng: seededRng(42) });
    expect(b.actions).toEqual(a.actions);
    expect(b.state).toEqual(a.state);
  });
});
