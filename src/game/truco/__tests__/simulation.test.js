import { describe, expect, it } from 'vitest';
import { PHASES } from '../state.js';
import { projectStateFor } from '../views.js';
import { seededRng } from './helpers.js';
import { simulateMatch } from './simulation.js';

// SIM_MATCHES cambia la cantidad (la corrida nocturna usa 100.000 por modo y configuración; la mutación, pocas)
const MATCHES_PER_CONFIG = Number(process.env.SIM_MATCHES || 300);
const MATCHES_2V2_PER_CONFIG = Math.max(1, Math.round(MATCHES_PER_CONFIG / 5));
// 300 partidas completas por configuración: es CPU puro y en una máquina cargada pasa los 30 s por defecto
const SIMULATION_TIMEOUT_MS = Math.max(120000, MATCHES_PER_CONFIG * 400);

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

  // Menos partidas que en 1 vs 1: en cada paso se proyecta el estado para los 4 jugadores
  it.each([15, 30])('2 vs 2 a %i puntos: 4 bots siempre terminan y nadie ve cartas ajenas', (targetPoints) => {
    for (let seed = 1; seed <= MATCHES_2V2_PER_CONFIG; seed++) {
      let prevScore = [0, 0];
      const { state } = simulateMatch({
        targetPoints,
        players: 4,
        rng: seededRng(seed * 104729 + targetPoints),
        onStep: (s) => {
          s.score.forEach((points, team) => {
            expect(points).toBeGreaterThanOrEqual(prevScore[team]);
            expect(points).toBeLessThanOrEqual(targetPoints);
          });
          prevScore = [...s.score];
          if (!s.hand) return;
          // 12 cartas, cada una en un solo lugar, y nadie juega más de una carta por baza
          const inHands = Object.values(s.hand.cards).flat();
          const played = s.hand.bazas.flatMap((b) => b.plays.map((p) => p.cardId));
          expect(inHands.length + played.length).toBe(12);
          expect(new Set([...inHands, ...played]).size).toBe(12);
          for (const b of s.hand.bazas) expect(new Set(b.plays.map((p) => p.playerId)).size).toBe(b.plays.length);
          // Las proyecciones nunca llevan cartas no jugadas de otro jugador (ni del compañero)
          for (const p of s.players) {
            const view = JSON.stringify(projectStateFor(s, p.id));
            for (const other of s.players) {
              if (other.id === p.id) continue;
              for (const card of s.hand.cards[other.id]) expect(view).not.toContain(`"${card}"`);
            }
          }
        }
      });
      expect(state.phase).toBe(PHASES.FINISHED);
      expect(state.score[state.winnerTeam]).toBe(targetPoints);
    }
  }, SIMULATION_TIMEOUT_MS * 2);

  it('es determinístico: mismo mazo y mismas acciones, mismo resultado', () => {
    const a = simulateMatch({ targetPoints: 30, rng: seededRng(42) });
    const b = simulateMatch({ targetPoints: 30, rng: seededRng(42) });
    expect(b.actions).toEqual(a.actions);
    expect(b.state).toEqual(a.state);
  });
});
