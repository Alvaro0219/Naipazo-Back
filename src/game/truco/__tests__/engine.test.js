import { describe, expect, it } from 'vitest';
import {
  applyAction, applyTimeout, dealNextHand, forfeitMatch, getAvailableActions
} from '../engine.js';
import { PHASES, createMatchState } from '../state.js';
import { A, B, makeDeck, run, startMatch } from './helpers.js';

const WEAK_B = ['4-copa', '5-copa', '6-basto']; // tantos 5

describe('creación de partida', () => {
  it('acepta 15 o 30 puntos y rechaza otra cosa', () => {
    expect(() => createMatchState({ config: { targetPoints: 15 }, playerIds: [A, B] })).not.toThrow();
    expect(() => createMatchState({ config: { targetPoints: 20 }, playerIds: [A, B] }))
      .toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('la flor todavía no está soportada', () => {
    expect(() => createMatchState({ config: { targetPoints: 15, withFlor: true }, playerIds: [A, B] }))
      .toThrow(expect.objectContaining({ code: 'FLOR_NOT_SUPPORTED' }));
  });

  it('R-REP-01: reparte de a una empezando por el mano y no deja jugar antes del reparto', () => {
    const initial = createMatchState({ config: { targetPoints: 15 }, playerIds: [A, B], dealerSeat: 1 });
    expect(() => applyAction(initial, A, { type: 'GO_TO_DECK' })).toThrow(expect.objectContaining({ code: 'HAND_OVER' }));
    const { state, events } = dealNextHand(initial, makeDeck(['1-espada', '2-oro', '3-oro'], WEAK_B));
    expect(state.hand.cards[A]).toEqual(['1-espada', '2-oro', '3-oro']);
    expect(state.hand.cards[B]).toEqual(WEAK_B);
    expect(events[0]).toMatchObject({ type: 'HAND_STARTED', manoId: A, dealerId: B });
  });

  it('rechaza mazos inválidos', () => {
    const initial = createMatchState({ config: { targetPoints: 15 }, playerIds: [A, B] });
    expect(() => dealNextHand(initial, ['1-espada'])).toThrow(expect.objectContaining({ code: 'INVALID_DECK' }));
  });
});

describe('bazas', () => {
  it('R-BAZA-01 / R-TURNO-02: gana la carta más alta, quien gana una baza juega primero la siguiente', () => {
    const state = startMatch({ mano: ['1-espada', '4-oro', '5-copa'], pie: ['3-oro', '4-copa', '6-basto'] });
    const r = run(state, [
      [A, 'PLAY_CARD', '1-espada'], [B, 'PLAY_CARD', '4-copa'], // gana A
      [A, 'PLAY_CARD', '4-oro'], [B, 'PLAY_CARD', '3-oro'] // gana B
    ]);
    expect(r.state.hand.turnSeat).toBe(1); // B ganó la segunda y abre la tercera
    const end = run(r.state, [[B, 'PLAY_CARD', '6-basto'], [A, 'PLAY_CARD', '5-copa']]);
    expect(end.state.score).toEqual([0, 1]);
    expect(end.state.phase).toBe(PHASES.HAND_OVER);
    expect(end.events).toContainEqual(expect.objectContaining({ type: 'HAND_WON', winnerTeam: 1, points: 1 }));
  });

  it('R-MANO-02: gana la mano quien gana las dos primeras, sin jugar la tercera', () => {
    const state = startMatch({ mano: ['1-espada', '1-basto', '4-oro'], pie: WEAK_B });
    const r = run(state, [
      [A, 'PLAY_CARD', '1-espada'], [B, 'PLAY_CARD', '4-copa'],
      [A, 'PLAY_CARD', '1-basto'], [B, 'PLAY_CARD', '5-copa']
    ]);
    expect(r.state.score).toEqual([1, 0]);
    expect(r.state.hand.bazas).toHaveLength(2);
  });

  it('parda en la primera: define la segunda', () => {
    const state = startMatch({ mano: ['3-oro', '4-oro', '5-oro'], pie: ['3-copa', '7-espada', '4-copa'] });
    const r = run(state, [
      [A, 'PLAY_CARD', '3-oro'], [B, 'PLAY_CARD', '3-copa'],
      [A, 'PLAY_CARD', '4-oro'], [B, 'PLAY_CARD', '7-espada']
    ]);
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'BAZA_WON', bazaIndex: 0, winnerTeam: null }));
    expect(r.state.score).toEqual([0, 1]);
  });

  it('parda en la segunda: gana quien ganó la primera', () => {
    const state = startMatch({ mano: ['4-oro', '3-oro', '5-oro'], pie: ['1-espada', '3-copa', '4-copa'] });
    const r = run(state, [
      [A, 'PLAY_CARD', '4-oro'], [B, 'PLAY_CARD', '1-espada'],
      [B, 'PLAY_CARD', '3-copa'], [A, 'PLAY_CARD', '3-oro']
    ]);
    expect(r.state.score).toEqual([0, 1]);
  });

  it('1 a 1 y parda en la tercera: gana quien ganó la primera', () => {
    const state = startMatch({ mano: ['1-espada', '4-oro', '2-oro'], pie: ['4-copa', '1-basto', '2-copa'] });
    const r = run(state, [
      [A, 'PLAY_CARD', '1-espada'], [B, 'PLAY_CARD', '4-copa'],
      [A, 'PLAY_CARD', '4-oro'], [B, 'PLAY_CARD', '1-basto'],
      [B, 'PLAY_CARD', '2-copa'], [A, 'PLAY_CARD', '2-oro']
    ]);
    expect(r.state.score).toEqual([1, 0]);
  });

  it('R-MANO-01 / R-TURNO-02: tres pardas: gana el mano, y con parda abre el mano', () => {
    const state = startMatch({ mano: ['3-oro', '2-oro', '12-oro'], pie: ['3-copa', '2-copa', '12-copa'] });
    const first = run(state, [[A, 'PLAY_CARD', '3-oro'], [B, 'PLAY_CARD', '3-copa']]);
    expect(first.state.hand.turnSeat).toBe(0);
    const r = run(first.state, [
      [A, 'PLAY_CARD', '2-oro'], [B, 'PLAY_CARD', '2-copa'],
      [A, 'PLAY_CARD', '12-oro'], [B, 'PLAY_CARD', '12-copa']
    ]);
    expect(r.state.score).toEqual([1, 0]);
  });

  it('R-REP-02: el repartidor rota y el mano cambia en cada mano', () => {
    const state = startMatch({ mano: ['1-espada', '1-basto', '4-oro'], pie: WEAK_B });
    const r = run(state, [[A, 'GO_TO_DECK']]);
    const next = dealNextHand(r.state, makeDeck(WEAK_B, ['1-espada', '1-basto', '4-oro']));
    expect(next.state.hand.manoSeat).toBe(1);
    expect(next.events[0]).toMatchObject({ manoId: B, dealerId: A });
    expect(() => dealNextHand(next.state, makeDeck(WEAK_B, ['1-espada', '1-basto', '4-oro'])))
      .toThrow(expect.objectContaining({ code: 'HAND_IN_PROGRESS' }));
  });
});

describe('truco', () => {
  const STRONG_A = ['1-espada', '1-basto', '7-espada'];

  it('no querido: quien cantó suma 1', () => {
    const r = run(startMatch({ mano: STRONG_A, pie: WEAK_B }), [[A, 'CALL_TRUCO'], [B, 'REJECT']]);
    expect(r.state.score).toEqual([1, 0]);
    expect(r.state.hand.result).toMatchObject({ winnerTeam: 0, points: 1, reason: 'truco_rejected' });
  });

  it('querido: la mano vale 2', () => {
    const r = run(startMatch({ mano: STRONG_A, pie: WEAK_B }), [
      [A, 'CALL_TRUCO'], [B, 'ACCEPT'],
      [A, 'PLAY_CARD', '1-espada'], [B, 'PLAY_CARD', '4-copa'],
      [A, 'PLAY_CARD', '1-basto'], [B, 'PLAY_CARD', '5-copa']
    ]);
    expect(r.state.score).toEqual([2, 0]);
  });

  it('R-TRUCO-02 / R-TRUCO-03: solo sube quien tiene el quiero, y subir implica querer', () => {
    let { state } = run(startMatch({ mano: STRONG_A, pie: WEAK_B }), [[A, 'CALL_TRUCO'], [B, 'ACCEPT']]);
    expect(state.hand.truco).toEqual({ level: 2, holderTeam: 1 });
    expect(() => applyAction(state, A, { type: 'CALL_RETRUCO' }))
      .toThrow(expect.objectContaining({ code: 'ACTION_NOT_ALLOWED' }));

    ({ state } = run(state, [[A, 'PLAY_CARD', '1-espada'], [B, 'CALL_RETRUCO']]));
    expect(getAvailableActions(state, A)).toEqual(
      expect.arrayContaining(['ACCEPT', 'REJECT', 'CALL_VALE_CUATRO', 'GO_TO_DECK'])
    );
    const r = run(state, [[A, 'CALL_VALE_CUATRO'], [B, 'REJECT']]);
    expect(r.state.score).toEqual([3, 0]); // vale cuatro no querido: 3
  });

  it('retruco no querido paga 2', () => {
    const r = run(startMatch({ mano: STRONG_A, pie: WEAK_B }), [
      [A, 'CALL_TRUCO'], [B, 'CALL_RETRUCO'], [A, 'REJECT']
    ]);
    expect(r.state.score).toEqual([0, 2]);
  });

  it('R-TRUCO-01: después del vale cuatro no se puede seguir subiendo', () => {
    const { state } = run(startMatch({ mano: STRONG_A, pie: WEAK_B }), [
      [A, 'CALL_TRUCO'], [B, 'CALL_RETRUCO'], [A, 'CALL_VALE_CUATRO'], [B, 'ACCEPT']
    ]);
    expect(state.hand.truco.level).toBe(4);
    expect(getAvailableActions(state, A).filter((t) => t.startsWith('CALL_'))).toEqual([]);
  });
});

describe('envido', () => {
  const A33 = ['7-espada', '6-espada', '4-oro'];

  it('R-ENV-05: querido y gana el mano: el pie dice "son buenas" y sus tantos no se revelan', () => {
    const r = run(startMatch({ mano: A33, pie: ['5-copa', '4-copa', '1-oro'] }), [[A, 'CALL_ENVIDO'], [B, 'ACCEPT']]);
    expect(r.state.score).toEqual([2, 0]);
    const result = r.events.find((e) => e.type === 'ENVIDO_RESULT');
    expect(result).toEqual({ type: 'ENVIDO_RESULT', accepted: true, tantos: { A: 33 }, winnerTeam: 0, points: 2 });
    expect(JSON.stringify(r.state.hand.envido.result)).not.toContain('29');
    expect(r.state.hand.turnSeat).toBe(0);
    expect(r.state.hand.pending).toBeNull();
  });

  it('querido y gana el pie: canta el mano primero y después el pie, que lo supera', () => {
    const r = run(startMatch({ mano: ['4-basto', '5-copa', '12-oro'], pie: A33 }), [[A, 'CALL_ENVIDO'], [B, 'ACCEPT']]);
    expect(r.state.score).toEqual([0, 2]);
    const result = r.events.find((e) => e.type === 'ENVIDO_RESULT');
    expect(result.tantos).toEqual({ A: 5, B: 33 });
    expect(Object.keys(result.tantos)).toEqual([A, B]); // en orden: primero el mano
  });

  it('R-ENV-05: empate de tantos: gana el mano y el pie no los revela', () => {
    const r = run(startMatch({ mano: A33, pie: ['7-copa', '6-copa', '4-basto'] }), [[A, 'CALL_ENVIDO'], [B, 'ACCEPT']]);
    expect(r.state.score).toEqual([2, 0]);
    expect(r.state.hand.envido.result.tantos).toEqual({ A: 33 });
  });

  it('no querido después de subidas: suma lo aceptado antes de la última', () => {
    const r = run(startMatch({ mano: A33, pie: WEAK_B }), [
      [A, 'CALL_ENVIDO'], [B, 'CALL_ENVIDO'], [A, 'CALL_REAL_ENVIDO'], [B, 'REJECT']
    ]);
    expect(r.state.score).toEqual([4, 0]);
  });

  it('R-ENV-03: el pie puede cantar después de que el mano jugó su carta', () => {
    const r = run(startMatch({ mano: A33, pie: WEAK_B }), [
      [A, 'PLAY_CARD', '4-oro'], [B, 'CALL_REAL_ENVIDO'], [A, 'REJECT']
    ]);
    expect(r.state.score).toEqual([0, 1]);
    expect(r.state.hand.turnSeat).toBe(1); // vuelve a B para jugar su carta
  });

  it('R-ENV-03: no se puede cantar en la segunda baza ni dos veces en la mano', () => {
    const played = run(startMatch({ mano: A33, pie: WEAK_B }), [
      [A, 'PLAY_CARD', '7-espada'], [B, 'PLAY_CARD', '4-copa']
    ]).state;
    expect(() => applyAction(played, A, { type: 'CALL_ENVIDO' }))
      .toThrow(expect.objectContaining({ code: 'ACTION_NOT_ALLOWED' }));

    const sung = run(startMatch({ mano: A33, pie: WEAK_B }), [[A, 'CALL_ENVIDO'], [B, 'REJECT']]).state;
    expect(getAvailableActions(sung, A)).not.toContain('CALL_ENVIDO');
  });

  it('R-ENV-03: no se puede cantar una vez querido el truco', () => {
    const { state } = run(startMatch({ mano: A33, pie: WEAK_B }), [[A, 'CALL_TRUCO'], [B, 'ACCEPT']]);
    expect(getAvailableActions(state, A)).not.toContain('CALL_ENVIDO');
  });

  it('R-ENV-08: el envido está primero: se resuelve y vuelve el truco pendiente', () => {
    let { state } = run(startMatch({ mano: A33, pie: WEAK_B }), [[A, 'CALL_TRUCO'], [B, 'CALL_ENVIDO']]);
    expect(state.hand.pending).toMatchObject({ kind: 'envido', callerTeam: 1 });
    ({ state } = run(state, [[A, 'ACCEPT']]));
    expect(state.score).toEqual([2, 0]);
    expect(state.hand.pending).toMatchObject({ kind: 'truco', level: 2, callerTeam: 0 });
    expect(getAvailableActions(state, B)).not.toContain('CALL_ENVIDO');
    ({ state } = run(state, [[B, 'ACCEPT']]));
    expect(state.hand.truco.level).toBe(2);
  });

  it('R-ENV-08: el envido está primero no aplica al retruco', () => {
    const { state } = run(startMatch({ mano: A33, pie: WEAK_B }), [[A, 'CALL_TRUCO'], [B, 'CALL_RETRUCO']]);
    expect(getAvailableActions(state, A)).not.toContain('CALL_ENVIDO');
  });
});

describe('falta envido y fin de partida a mitad de mano', () => {
  const WEAK_A = ['4-oro', '5-copa', '12-basto'];
  const B33 = ['7-espada', '6-espada', '1-oro'];

  it('R-ENV-07 / R-FIN-01 / R-FIN-03: a 15: la falta le da al ganador lo que le falta al líder y la partida termina', () => {
    const r = run(startMatch({ mano: WEAK_A, pie: B33, score: [12, 13] }), [[A, 'CALL_FALTA_ENVIDO'], [B, 'ACCEPT']]);
    expect(r.state.score).toEqual([12, 15]);
    expect(r.state.phase).toBe(PHASES.FINISHED);
    expect(r.state.winnerTeam).toBe(1);
    expect(r.events.at(-1)).toMatchObject({ type: 'MATCH_FINISHED', winnerTeam: 1 });
    expect(() => applyAction(r.state, A, { type: 'PLAY_CARD', payload: { cardId: '4-oro' } }))
      .toThrow(expect.objectContaining({ code: 'MATCH_FINISHED' }));
  });

  it('a 30 con el líder en buenas: cuenta hasta 30', () => {
    const r = run(startMatch({ targetPoints: 30, mano: B33, pie: WEAK_A, score: [16, 3] }), [
      [A, 'CALL_FALTA_ENVIDO'], [B, 'ACCEPT']
    ]);
    expect(r.state.score).toEqual([30, 3]);
    expect(r.state.phase).toBe(PHASES.FINISHED);
  });

  it('a 30 con el líder en malas: cuenta hasta 15', () => {
    const r = run(startMatch({ targetPoints: 30, mano: B33, pie: WEAK_A, score: [6, 9] }), [
      [A, 'CALL_FALTA_ENVIDO'], [B, 'ACCEPT']
    ]);
    expect(r.state.score).toEqual([12, 9]);
    expect(r.state.phase).toBe(PHASES.PLAYING);
  });

  it('R-FIN-01: un envido no querido también puede cerrar la partida', () => {
    const r = run(startMatch({ mano: WEAK_A, pie: B33, score: [14, 0] }), [[A, 'CALL_ENVIDO'], [B, 'REJECT']]);
    expect(r.state.phase).toBe(PHASES.FINISHED);
    expect(r.state.winnerTeam).toBe(0);
  });
});

describe('ir al mazo', () => {
  const HAND_A = ['1-espada', '4-oro', '5-oro'];

  it('en la primera baza sin envido cantado: el rival suma 1 + 1 por el envido', () => {
    const r = run(startMatch({ mano: HAND_A, pie: WEAK_B }), [[A, 'GO_TO_DECK']]);
    expect(r.state.score).toEqual([0, 2]);
    expect(r.state.hand.result).toMatchObject({ reason: 'deck', points: 2 });
  });

  it('R-MAZO-IR-02: respondiendo un truco en la primera baza: 1 + 1', () => {
    const r = run(startMatch({ mano: HAND_A, pie: WEAK_B }), [[A, 'CALL_TRUCO'], [B, 'GO_TO_DECK']]);
    expect(r.state.score).toEqual([2, 0]);
  });

  it('con el envido ya jugado: solo lo del truco', () => {
    const r = run(startMatch({ mano: HAND_A, pie: WEAK_B }), [
      [A, 'CALL_ENVIDO'], [B, 'REJECT'], [A, 'GO_TO_DECK']
    ]);
    expect(r.state.score).toEqual([1, 1]);
  });

  it('R-MAZO-IR-02: con un envido pendiente equivale a no quererlo', () => {
    const r = run(startMatch({ mano: HAND_A, pie: WEAK_B }), [[A, 'CALL_ENVIDO'], [B, 'GO_TO_DECK']]);
    expect(r.state.score).toEqual([2, 0]); // 1 del envido no querido + 1 de la mano
  });

  it('en la segunda baza con truco querido: el valor del truco', () => {
    const r = run(startMatch({ mano: HAND_A, pie: WEAK_B }), [
      [A, 'CALL_TRUCO'], [B, 'ACCEPT'],
      [A, 'PLAY_CARD', '1-espada'], [B, 'PLAY_CARD', '4-copa'],
      [A, 'GO_TO_DECK']
    ]);
    expect(r.state.score).toEqual([0, 2]);
  });
});

describe('acciones ilegales', () => {
  const state = startMatch({ mano: ['1-espada', '4-oro', '5-oro'], pie: WEAK_B });

  it.each([
    ['jugar fuera de turno', B, { type: 'PLAY_CARD', payload: { cardId: '4-copa' } }, 'NOT_YOUR_TURN'],
    ['jugar una carta que no tiene', A, { type: 'PLAY_CARD', payload: { cardId: '4-copa' } }, 'CARD_NOT_IN_HAND'],
    ['responder sin canto', A, { type: 'ACCEPT' }, 'NOTHING_TO_ANSWER'],
    ['cantar fuera de turno', B, { type: 'CALL_TRUCO' }, 'ACTION_NOT_ALLOWED'],
    ['retruco sin truco', A, { type: 'CALL_RETRUCO' }, 'ACTION_NOT_ALLOWED'],
    ['acción desconocida', A, { type: 'CALL_FLOR' }, 'UNKNOWN_ACTION'],
    ['no es jugador', 'Z', { type: 'GO_TO_DECK' }, 'NOT_A_PLAYER']
  ])('%s', (_, playerId, action, code) => {
    expect(() => applyAction(state, playerId, action)).toThrow(expect.objectContaining({ code }));
  });

  it('R-TURNO-03: quien cantó no puede jugar ni responder su propio canto', () => {
    const { state: s } = run(state, [[A, 'CALL_TRUCO']]);
    expect(() => applyAction(s, A, { type: 'PLAY_CARD', payload: { cardId: '1-espada' } }))
      .toThrow(expect.objectContaining({ code: 'NOT_YOUR_TURN' }));
    expect(() => applyAction(s, A, { type: 'ACCEPT' })).toThrow(expect.objectContaining({ code: 'NOT_YOUR_TURN' }));
    expect(getAvailableActions(s, A)).toEqual([]);
  });

  it('R-TURNO-01: una acción, válida o no, nunca modifica el estado recibido', () => {
    const snapshot = structuredClone(state);
    applyAction(state, A, { type: 'PLAY_CARD', payload: { cardId: '1-espada' } });
    expect(() => applyAction(state, B, { type: 'ACCEPT' })).toThrow();
    expect(state).toEqual(snapshot);
  });
});

describe('tiempo y abandono', () => {
  const state = startMatch({ mano: ['1-espada', '4-oro', '5-oro'], pie: WEAK_B });

  it('R-TIEMPO-02: vence el tiempo con un canto pendiente: no quiero', () => {
    const { state: s } = run(state, [[A, 'CALL_TRUCO']]);
    const r = applyTimeout(s);
    expect(r.playerId).toBe(B);
    expect(r.state.score).toEqual([1, 0]);
    expect(r.events[0]).toMatchObject({ type: 'TURN_TIMEOUT', playerId: B });
  });

  it('R-TIEMPO-01: vence el tiempo para jugar: pierde la mano (sin el punto del envido)', () => {
    const r = applyTimeout(state);
    expect(r.state.score).toEqual([0, 1]);
    expect(r.state.hand.result).toMatchObject({ reason: 'timeout' });
  });

  it('R-ABAND-03: abandono: gana el otro equipo sin tocar el marcador', () => {
    const r = forfeitMatch(state, 0);
    expect(r.state.phase).toBe(PHASES.FINISHED);
    expect(r.state.winnerTeam).toBe(1);
    expect(r.state.endReason).toBe('abandon');
    expect(r.state.score).toEqual([0, 0]);
  });
});
