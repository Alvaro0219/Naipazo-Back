// Bordes y errores del motor: validaciones que no aparecen en una partida normal (cobertura de ramas al 100 %).
import { describe, expect, it } from 'vitest';
import { applyAction, applyTimeout, dealNextHand, forfeitMatch } from '../engine.js';
import { canRaiseEnvido } from '../envido.js';
import { RULES_VERSION, createMatchState as createFromIndex } from '../index.js';
import { checkInvariants } from '../invariants.js';
import { createMatchState } from '../state.js';
import { projectStateFor } from '../views.js';
import { A, B, makeDeck, run, startMatch } from './helpers.js';

const MANO = ['4-copa', '5-oro', '6-basto'];
const PIE = ['4-espada', '5-copa', '6-oro'];
const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };

describe('bordes del motor', () => {
  it('R-REP-01: la partida necesita 2 o 4 jugadores distintos y un repartidor válido', () => {
    expect(code(() => createMatchState({ config: { targetPoints: 15 }, playerIds: [A] }))).toBe('INVALID_CONFIG');
    expect(code(() => createMatchState({ config: { targetPoints: 15 }, playerIds: [A, A] }))).toBe('INVALID_CONFIG');
    expect(code(() => createMatchState({ config: { targetPoints: 15 }, playerIds: [A, B, 'C'] }))).toBe('INVALID_CONFIG');
    expect(code(() => createMatchState({ config: { targetPoints: 15 }, playerIds: [A, B], dealerSeat: 2 }))).toBe('INVALID_CONFIG');
    expect(code(() => createMatchState({ config: { targetPoints: 15 }, playerIds: [A, B], dealerSeat: 1.5 }))).toBe('INVALID_CONFIG');
    expect(code(() => createMatchState({ config: { targetPoints: 15 }, playerIds: [A, B], dealerSeat: -1 }))).toBe('INVALID_CONFIG');
    expect(code(() => createMatchState({ playerIds: [A, B] }))).toBe('INVALID_CONFIG');
    expect(RULES_VERSION).toBe(1);
    expect(createFromIndex({ config: { targetPoints: 30 }, playerIds: [A, B] }).config.targetPoints).toBe(30);
  });

  it('R-FIN-01: no se reparte con la mano en juego ni con la partida terminada, y no se actúa después del final', () => {
    const s = startMatch({ mano: MANO, pie: PIE });
    expect(code(() => dealNextHand(s, makeDeck(MANO, PIE)))).toBe('HAND_IN_PROGRESS');
    const finished = forfeitMatch(s, 0).state;
    expect(code(() => dealNextHand(finished, makeDeck(MANO, PIE)))).toBe('MATCH_FINISHED');
    expect(code(() => forfeitMatch(finished, 1))).toBe('MATCH_FINISHED');
    expect(code(() => applyAction(finished, A, { type: 'PLAY_CARD', payload: { cardId: '4-copa' } }))).toBe('MATCH_FINISHED');
    expect(code(() => applyTimeout(finished))).toBe('HAND_OVER');
  });

  it('R-TURNO-01: acciones sin forma, de quien no juega o de tipo desconocido se rechazan', () => {
    const s = startMatch({ mano: MANO, pie: PIE });
    expect(code(() => applyAction(s, A, null))).toBe('UNKNOWN_ACTION');
    expect(code(() => applyAction(s, 'X', { type: 'GO_TO_DECK' }))).toBe('NOT_A_PLAYER');
    expect(code(() => applyAction(s, A, { type: 'PLAY_CARD', payload: { cardId: '1-espada' } }))).toBe('CARD_NOT_IN_HAND');
    expect(code(() => applyAction(s, B, { type: 'GO_TO_DECK' }))).toBe('NOT_YOUR_TURN');
    expect(code(() => applyAction(s, B, { type: 'ACCEPT' }))).toBe('NOTHING_TO_ANSWER');
  });

  it('R-ENV-02: una subida de envido desconocida nunca se permite', () => {
    expect(canRaiseEnvido(['ENVIDO'], 'CUALQUIERA')).toBe(false);
  });

  it('R-VIS-01: proyectar para alguien que no juega falla, y antes del primer reparto no hay mano', () => {
    const initial = createMatchState({ config: { targetPoints: 15 }, playerIds: [A, B] });
    expect(code(() => projectStateFor(initial, 'X'))).toBe('NOT_A_PLAYER');
    const view = projectStateFor(initial, A);
    expect(view.hand).toBeNull();
    expect(view.players.every((p) => p.cardsInHand === 0)).toBe(true);
  });

  it('R-REP-01: el detector de invariantes salta con un mazo inválido y con un envido que se reabre o fuera de la 1.ª baza', () => {
    const s = startMatch({ mano: MANO, pie: PIE });
    const badDeck = structuredClone(s);
    badDeck.hand.deck = badDeck.hand.deck.slice(0, 39);
    expect(checkInvariants(badDeck).map((x) => x.id)).toContain('I-C1');

    const done = run(s, [[A, 'CALL_ENVIDO'], [B, 'REJECT']]).state;
    const reopened = structuredClone(done);
    reopened.hand.envido.status = 'none';
    expect(checkInvariants(reopened, done).map((x) => x.id)).toContain('I-T4');

    const late = run(s, [[A, 'PLAY_CARD', '5-oro'], [B, 'PLAY_CARD', '4-espada']]).state;
    const calling = structuredClone(late);
    calling.hand.envido.status = 'calling';
    expect(checkInvariants(calling).map((x) => x.id)).toContain('I-T4');

    const badPending = run(s, [[A, 'CALL_TRUCO']]).state;
    badPending.hand.pending.responderSeat = 0;
    expect(checkInvariants(badPending).map((x) => x.id)).toContain('I-T2');

    // Nadie puede responder: cero actores
    const nobody = run(s, [[A, 'CALL_TRUCO']]).state;
    nobody.hand.pending.responderSeat = 7;
    expect(checkInvariants(nobody).map((x) => x.id)).toEqual(expect.arrayContaining(['I-T2', 'I-T1']));
  });

  it('R-REP-01: el detector salta con repartos y bazas imposibles', () => {
    const s = startMatch({ mano: MANO, pie: PIE });
    const ids = (st) => checkInvariants(st).map((x) => x.id);

    const short = structuredClone(s);
    short.hand.dealt[A] = ['4-copa', '5-oro'];
    expect(ids(short)).toContain('R-REP-01');

    const fromNowhere = structuredClone(s);
    fromNowhere.hand.dealt[B] = ['4-espada', '5-copa', '1-espada'];
    fromNowhere.hand.cards[B] = ['4-espada', '5-copa', '1-espada'];
    expect(ids(fromNowhere)).toContain('I-C2');

    const noCards = structuredClone(s);
    delete noCards.hand.cards[A];
    delete noCards.hand.dealt[A];
    expect(ids(noCards)).toEqual(expect.arrayContaining(['R-REP-01', 'I-C2']));

    const incomplete = structuredClone(s);
    incomplete.hand.bazas[0] = { plays: [{ playerId: A, cardId: '4-copa' }], winnerTeam: 0, leaderSeat: 0 };
    incomplete.hand.cards[A] = ['5-oro', '6-basto'];
    expect(ids(incomplete)).toContain('I-C5');

    const fourBazas = structuredClone(s);
    fourBazas.hand.bazas = [0, 1, 2, 3].map(() => ({ plays: [], winnerTeam: undefined, leaderSeat: 0 }));
    expect(ids(fourBazas)).toContain('I-C4');

    const badTruco = structuredClone(s);
    badTruco.hand.truco.level = 5;
    expect(ids(badTruco)).toContain('I-T3');

    const badDeckCards = structuredClone(s);
    badDeckCards.hand.deck[39] = 'x-x';
    expect(ids(badDeckCards)).toContain('I-C1');
  });

  it('R-TIEMPO-01: el tiempo vencido avisa quién se quedó sin tiempo (evento TURN_TIMEOUT)', () => {
    const s = startMatch({ mano: MANO, pie: PIE });
    const { events, playerId } = applyTimeout(s);
    expect(playerId).toBe(A);
    expect(events[0]).toEqual({ type: 'TURN_TIMEOUT', playerId: A });
  });

  it('R-ABAND-01: el abandono cierra el canto pendiente, funciona entre manos y anuncia el resultado', () => {
    const pending = run(startMatch({ mano: MANO, pie: PIE, score: [4, 9] }), [[A, 'CALL_TRUCO']]).state;
    const r = forfeitMatch(pending, 0);
    expect(r.state.hand.pending).toBeNull();
    expect(r.events).toEqual([{ type: 'MATCH_FINISHED', winnerTeam: 1, score: [4, 9], reason: 'abandon' }]);
    const between = createMatchState({ config: { targetPoints: 15 }, playerIds: [A, B] });
    const r2 = forfeitMatch(between, 1, 'timeout');
    expect(r2.state).toMatchObject({ hand: null, phase: 'finished', winnerTeam: 0, endReason: 'timeout' });
  });

  it('R-MAZO-IR-02: irse al mazo con un envido pendiente que define la partida la termina ahí', () => {
    const s = run(startMatch({ mano: MANO, pie: PIE, score: [14, 3] }), [[A, 'CALL_ENVIDO']]).state;
    const r = applyAction(s, B, { type: 'GO_TO_DECK' });
    expect(r.state).toMatchObject({ phase: 'finished', winnerTeam: 0, score: [15, 3] });
    expect(r.events[0]).toEqual({ type: 'WENT_TO_DECK', playerId: B });
    expect(r.events.some((e) => e.type === 'HAND_WON')).toBe(false);
  });
});
