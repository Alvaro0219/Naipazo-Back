// Repeticiones de referencia (EXACTITUD_DEL_JUEGO.md, 9.4): cada archivo de fixtures/replays/ tiene las manos, las
// acciones y el resultado esperado de un guion de la sección 11. El motor tiene que reproducirlas todas exactamente;
// si una regla cambia a propósito, se sube RULES_VERSION y se actualizan.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALL_CARD_IDS } from '../cards.js';
import { applyAction, applyTimeout, dealNextHand, getAvailableActions } from '../engine.js';
import { RULES_VERSION } from '../rules.js';
import { createMatchState } from '../state.js';
import { projectStateFor } from '../views.js';

const DIR = new URL('../../../../fixtures/replays/', import.meta.url);
const replays = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()
  .map((file) => ({ file, ...JSON.parse(readFileSync(new URL(file, DIR), 'utf8')) }));
const PLAYERS = { '1v1': ['A', 'B'], '2v2': ['A1', 'B1', 'A2', 'B2'] };

/** Mazo que reparte `manos[asiento]` a cada uno, de a una carta empezando por el mano (asiento 0). */
function deckFor(manos) {
  const dealt = [];
  for (let r = 0; r < 3; r++) for (const hand of manos) dealt.push(hand[r]);
  return [...dealt, ...ALL_CARD_IDS.filter((c) => !dealt.includes(c))];
}

/** `expected` aparece en `events` en ese orden (pueden haber otros eventos en el medio). */
function expectSubsequence(events, expected) {
  let i = 0;
  for (const e of events) {
    if (i < expected.length && Object.entries(expected[i]).every(([k, v]) => JSON.stringify(e[k]) === JSON.stringify(v))) i++;
  }
  expect(i, `eventos esperados ${JSON.stringify(expected)} en ${JSON.stringify(events)}`).toBe(expected.length);
}

function play(replay) {
  const ids = PLAYERS[replay.modo];
  let state = createMatchState({ config: { targetPoints: replay.objetivo }, playerIds: ids, dealerSeat: ids.length - 1 });
  state = { ...state, score: [...replay.marcador] };
  state = dealNextHand(state, deckFor(replay.manos)).state;
  const events = [];
  for (const [playerId, type, cardId] of replay.acciones) {
    const result = type === 'TIMEOUT'
      ? (() => {
        const r = applyTimeout(state);
        expect(r.playerId, 'el tiempo vence para quien tenía que decidir').toBe(playerId);
        return r;
      })()
      : applyAction(state, playerId, type === 'PLAY_CARD' ? { type, payload: { cardId } } : { type });
    state = result.state;
    events.push(...result.events);
  }
  return { state, events, ids };
}

describe('repeticiones de referencia (fixtures/replays)', () => {
  it('hay una por cada guion jugable con el motor (1 a 12 y 14 a 19)', () => {
    const guiones = new Set(replays.map((r) => r.guion));
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19]) expect(guiones.has(n), `guion ${n}`).toBe(true);
  });

  it.each(replays.map((r) => [`${r.file} (${r.reglas.join(', ')})`, r]))('%s', (_, replay) => {
    expect(replay.rulesVersion).toBe(RULES_VERSION);
    const { state, events, ids } = play(replay);
    const exp = replay.esperado;

    if (exp.fase) expect(state.phase).toBe(exp.fase);
    if (exp.marcador) expect(state.score).toEqual(exp.marcador);
    if (exp.resultadoMano) expect(state.hand.result).toEqual(exp.resultadoMano);
    if (exp.bazasJugadas) expect(state.hand.bazas.filter((b) => b.plays.length > 0)).toHaveLength(exp.bazasJugadas);
    if (exp.ganador !== undefined) expect(state.winnerTeam).toBe(exp.ganador);
    if (exp.motivo) expect(state.endReason).toBe(exp.motivo);
    if (exp.eventos) expectSubsequence(events, exp.eventos);
    if (exp.secciones) expect(projectStateFor(state, ids[0]).scoreSections).toEqual(exp.secciones);
    if (exp.turno) expect(projectStateFor(state, ids[0]).hand.turnPlayerId).toBe(exp.turno);
    if (exp.responde) {
      expect(getAvailableActions(state, exp.responde)).toEqual(expect.arrayContaining(['ACCEPT', 'REJECT']));
      for (const id of exp.sinAcciones) expect(getAvailableActions(state, id), id).toEqual([]);
    }
    // Tantos no revelados ("son buenas"): no van en ningún evento ni en la vista de ningún otro jugador
    for (const hidden of exp.tantosOcultos || []) {
      for (const e of events.filter((x) => x.type === 'ENVIDO_RESULT')) expect(e.tantos).not.toHaveProperty(hidden);
      for (const viewer of ids.filter((id) => id !== hidden)) {
        expect(JSON.stringify(projectStateFor(state, viewer))).not.toContain(`"${hidden}":`);
      }
    }
  });
});
