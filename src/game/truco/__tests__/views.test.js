import { describe, expect, it } from 'vitest';
import { applyAction } from '../engine.js';
import { projectStateFor } from '../views.js';
import { A, B, run, seededRng, startMatch } from './helpers.js';
import { simulateMatch } from './simulation.js';

const MANO = ['7-espada', '6-espada', '4-oro'];
const PIE = ['5-copa', '4-copa', '1-oro'];

/** Cartas del rival que todavía no jugó (las que nunca deben verse). */
function hiddenCardsFor(state, playerId) {
  if (!state.hand) return [];
  return state.players
    .filter((p) => p.id !== playerId)
    .flatMap((p) => state.hand.cards[p.id]);
}

describe('projectStateFor', () => {
  it('muestra mis cartas y no las del rival ni el mazo', () => {
    const state = startMatch({ mano: MANO, pie: PIE });
    const view = projectStateFor(state, A);
    const json = JSON.stringify(view);

    expect(view.hand.myCards).toEqual(MANO);
    for (const card of PIE) expect(json).not.toContain(card);
    expect(json).not.toContain('deck');
    expect(json).not.toContain('dealt');
    expect(view.players.find((p) => p.id === B).cardsInHand).toBe(3);
  });

  it('las cartas jugadas son públicas', () => {
    const { state } = run(startMatch({ mano: MANO, pie: PIE }), [[A, 'PLAY_CARD', '4-oro']]);
    expect(projectStateFor(state, B).hand.bazas[0].plays).toEqual([{ playerId: A, cardId: '4-oro' }]);
  });

  it('solo veo mis tantos hasta que se quiere el envido', () => {
    const state = startMatch({ mano: MANO, pie: PIE });
    expect(projectStateFor(state, A).hand.myTantos).toBe(33);
    expect(JSON.stringify(projectStateFor(state, B))).not.toContain('33');

    const { state: after } = run(state, [[A, 'CALL_ENVIDO'], [B, 'ACCEPT']]);
    expect(projectStateFor(after, B).hand.envido.result.tantos).toEqual({ A: 33, B: 29 });
  });

  it('las acciones disponibles son solo las del jugador que puede actuar', () => {
    const state = startMatch({ mano: MANO, pie: PIE });
    expect(projectStateFor(state, A).availableActions).toEqual(expect.arrayContaining(['PLAY_CARD', 'CALL_TRUCO', 'CALL_ENVIDO']));
    expect(projectStateFor(state, B).availableActions).toEqual([]);

    const { state: called } = applyAction(state, A, { type: 'CALL_TRUCO' });
    const viewB = projectStateFor(called, B);
    expect(viewB.availableActions).toEqual(expect.arrayContaining(['ACCEPT', 'REJECT', 'CALL_RETRUCO', 'CALL_ENVIDO']));
    expect(viewB.hand.pending).toMatchObject({ kind: 'truco', call: 'TRUCO', callerId: A });
    expect(viewB.hand.turnPlayerId).toBeNull();
  });

  it('en partidas completas nunca se filtra una carta del rival', () => {
    for (let seed = 1; seed <= 40; seed++) {
      simulateMatch({
        targetPoints: 15,
        rng: seededRng(seed),
        onStep: (state) => {
          for (const p of state.players) {
            const json = JSON.stringify(projectStateFor(state, p.id));
            for (const card of hiddenCardsFor(state, p.id)) {
              expect(json.includes(`"${card}"`), `${card} visible para ${p.id}`).toBe(false);
            }
          }
        }
      });
    }
  });
});
