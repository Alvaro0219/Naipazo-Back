// Pruebas por propiedades (EXACTITUD_DEL_JUEGO.md, 9.3) con fast-check: secuencias aleatorias de acciones
// LEGALES e ILEGALES de cualquier jugador. Corridas por propiedad: PROPS_RUNS (10.000 por defecto; la corrida
// nocturna usa 1.000.000). Cuando una propiedad falla, fast-check reduce el caso al mínimo: guardarlo como test fijo.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ACTION_TYPES, applyAction, dealNextHand, getAvailableActions } from '../engine.js';
import { checkInvariants } from '../invariants.js';
import { createMatchState, PHASES } from '../state.js';
import { projectStateFor } from '../views.js';
import { seededRng } from './helpers.js';
import { shuffleDeck } from '../deck.js';

const RUNS = Number(process.env.PROPS_RUNS || 10000);
const TIMEOUT = Math.max(120000, RUNS * 40);

/** Un "paso": qué jugador intenta qué acción y con qué carta (índice), legal o no. */
const stepArb = fc.record({
  player: fc.nat(3),
  type: fc.constantFrom(...ACTION_TYPES, 'CALL_FLOR', 'NADA'),
  card: fc.nat(2)
});
const caseArb = fc.record({
  players: fc.constantFrom(2, 4),
  target: fc.constantFrom(15, 30),
  seed: fc.nat(),
  dealer: fc.nat(3),
  steps: fc.array(stepArb, { minLength: 1, maxLength: 80 })
});

/** Juega el caso; llama a `check(prev, next, events, info)` después de cada intento. */
function play({ players, target, seed, dealer, steps }, check) {
  const rng = seededRng(seed);
  const ids = Array.from({ length: players }, (_, i) => `P${i}`);
  let state = createMatchState({ config: { targetPoints: target }, playerIds: ids, dealerSeat: dealer % players });
  const log = [];
  for (const step of steps) {
    if (state.phase === PHASES.FINISHED) break;
    if (state.phase === PHASES.HAND_OVER) {
      const deck = shuffleDeck(undefined, rng);
      const r = dealNextHand(state, deck);
      log.push({ deal: deck });
      check(state, r.state, r.events, { dealt: true });
      state = r.state;
      continue;
    }
    const playerId = ids[step.player % players];
    const cardId = state.hand.cards[playerId]?.[step.card] ?? 'x-x';
    const action = step.type === 'PLAY_CARD' ? { type: step.type, payload: { cardId } } : { type: step.type };
    const before = JSON.stringify(state);
    let r = null;
    try {
      r = applyAction(state, playerId, action);
    } catch (err) {
      // Acción ilegal: se rechaza con un RuleError y el estado NO cambia
      expect(err.name === 'RuleError' || err.code, `${step.type}: ${err.message}`).toBeTruthy();
      expect(JSON.stringify(state)).toBe(before);
      check(state, state, [], { rejected: true, playerId, action });
      continue;
    }
    log.push({ playerId, action });
    check(state, r.state, r.events, { playerId, action });
    state = r.state;
  }
  return { state, log, ids };
}

describe('propiedades del motor', () => {
  it('R-PUNT-01 / R-PUNT-02 / R-FIN-02 / R-TURNO-01: después de cada acción se cumplen todos los invariantes y las ilegales no cambian nada', () => {
    fc.assert(fc.property(caseArb, (c) => {
      play(c, (prev, next, events) => {
        expect(checkInvariants(next, prev)).toEqual([]);
        // R-PUNT-02: el puntaje solo cambia por eventos POINTS, y en la misma medida (topeado al objetivo)
        const gained = [0, 0];
        for (const e of events) if (e.type === 'POINTS') gained[e.team] += e.points;
        for (const team of [0, 1]) {
          const expected = Math.min(next.config.targetPoints, prev.score[team] + gained[team]);
          expect(next.score[team]).toBe(expected);
        }
      });
    }), { numRuns: RUNS });
  }, TIMEOUT);

  it('R-TURNO-01 (I-T5): las acciones disponibles de cada jugador son exactamente las que el motor acepta', () => {
    fc.assert(fc.property(caseArb, (c) => {
      play(c, (_prev, next) => {
        if (next.phase !== PHASES.PLAYING) return;
        for (const p of next.players) {
          const offered = new Set(getAvailableActions(next, p.id));
          for (const type of ACTION_TYPES) {
            const candidates = type === 'PLAY_CARD' ? next.hand.cards[p.id].map((cardId) => ({ type, payload: { cardId } })) : [{ type }];
            const accepted = candidates.some((a) => { try { applyAction(next, p.id, a); return true; } catch { return false; } });
            expect(accepted, `${p.id} ${type}`).toBe(offered.has(type));
          }
        }
      });
    }), { numRuns: Math.max(100, Math.round(RUNS / 10)) });
  }, TIMEOUT);

  it('R-VIS-01 / R-VIS-02 / R-MAZO-03: ninguna proyección lleva cartas ajenas no jugadas, el mazo ni tantos no revelados', () => {
    fc.assert(fc.property(caseArb, (c) => {
      play(c, (_prev, next) => {
        if (!next.hand) return;
        const revealed = new Set(Object.keys(next.hand.envido.result?.tantos || {}));
        for (const p of next.players) {
          const view = projectStateFor(next, p.id);
          const json = JSON.stringify(view);
          expect(json).not.toMatch(/"deck":|"dealt":/);
          for (const other of next.players) {
            if (other.id === p.id) continue;
            for (const card of next.hand.cards[other.id]) expect(json).not.toContain(`"${card}"`);
          }
          // Los únicos tantos visibles son los revelados en el canto
          expect(Object.keys(view.hand.envido.result?.tantos || {}).every((id) => revealed.has(id))).toBe(true);
        }
      });
    }), { numRuns: Math.max(100, Math.round(RUNS / 5)) });
  }, TIMEOUT);

  it('R-MAZO-02 (P3): determinismo: repetir el registro de una partida da exactamente el mismo estado', () => {
    fc.assert(fc.property(caseArb, (c) => {
      const { state, log, ids } = play(c, () => {});
      let replay = createMatchState({ config: { targetPoints: c.target }, playerIds: ids, dealerSeat: c.dealer % c.players });
      for (const entry of log) {
        replay = entry.deal ? dealNextHand(replay, entry.deal).state : applyAction(replay, entry.playerId, entry.action).state;
      }
      expect(replay).toEqual(state);
    }), { numRuns: RUNS });
  }, TIMEOUT);
});
