import { describe, expect, it } from 'vitest';
import { ALL_CARD_IDS } from '../cards.js';
import { applyAction, applyTimeout, dealNextHand, getActingPlayerIds, getAvailableActions } from '../engine.js';
import { PHASES, createMatchState } from '../state.js';
import { projectStateFor } from '../views.js';
import { run } from './helpers.js';

// Asientos: A1 (0, equipo A=0), B1 (1, equipo B=1), A2 (2, equipo A), B2 (3, equipo B).
// Reparte B2 (asiento 3), así el mano es A1 y el orden de la primera baza es A1, B1, A2, B2.
// Los pies (último de cada pareja) son A2 y B2.
const [A1, B1, A2, B2] = ['A1', 'B1', 'A2', 'B2'];
const PLAYERS = [A1, B1, A2, B2];

/** Mazo que reparte `hands[asiento]` a cada uno (de a una carta, empezando por el mano = asiento 0). */
function makeDeck4(hands) {
  const dealt = [];
  for (let r = 0; r < 3; r++) for (let seat = 0; seat < 4; seat++) dealt.push(hands[seat][r]);
  return [...dealt, ...ALL_CARD_IDS.filter((c) => !dealt.includes(c))];
}

function start4(hands, { targetPoints = 15 } = {}) {
  const initial = createMatchState({ config: { targetPoints }, playerIds: PLAYERS, dealerSeat: 3 });
  return dealNextHand(initial, makeDeck4(hands)).state;
}

const LOW = [
  ['4-copa', '5-oro', '6-basto'],
  ['4-espada', '5-copa', '6-oro'],
  ['4-basto', '5-espada', '6-copa'],
  ['4-oro', '5-basto', '6-espada']
];

describe('2 vs 2: reparto, turnos y bazas', () => {
  it('reparte 12 cartas distintas de a una desde el mano y rota quien reparte', () => {
    const initial = createMatchState({ config: { targetPoints: 15 }, playerIds: PLAYERS, dealerSeat: 3 });
    const { state, events } = dealNextHand(initial, makeDeck4(LOW));
    expect(PLAYERS.map((p) => state.hand.cards[p])).toEqual(LOW);
    expect(new Set(Object.values(state.hand.cards).flat()).size).toBe(12);
    expect(events[0]).toMatchObject({ manoId: A1, dealerId: B2 });
    expect(state.players.map((p) => p.team)).toEqual([0, 1, 0, 1]);

    // Turnos en orden 0 → 1 → 2 → 3
    expect(getActingPlayerIds(state)).toEqual([A1]);
    const r = run(state, [[A1, 'PLAY_CARD', '4-copa']]);
    expect(getActingPlayerIds(r.state)).toEqual([B1]);

    // Próxima mano: reparte A1 y es mano B1
    const next = dealNextHand({ ...state, phase: PHASES.HAND_OVER }, makeDeck4(LOW)).state;
    expect(next.hand.dealerSeat).toBe(0);
    expect(next.hand.manoSeat).toBe(1);
  });

  it('gana la carta más alta y quien la jugó abre la baza siguiente', () => {
    const state = start4([
      ['4-copa', '5-oro', '6-basto'],
      ['4-espada', '5-copa', '6-oro'],
      ['1-espada', '5-espada', '6-copa'],
      ['4-oro', '5-basto', '6-espada']
    ]);
    const r = run(state, [[A1, 'PLAY_CARD', '4-copa'], [B1, 'PLAY_CARD', '4-espada'], [A2, 'PLAY_CARD', '1-espada'], [B2, 'PLAY_CARD', '4-oro']]);
    expect(r.state.hand.bazas[0].winnerTeam).toBe(0);
    expect(r.events.find((e) => e.type === 'BAZA_WON')).toMatchObject({ winnerTeam: 0, winnerPlayerId: A2 });
    expect(r.state.hand.turnSeat).toBe(2);
    expect(r.state.hand.bazas[1].leaderSeat).toBe(2);
  });

  it('empate entre equipos distintos es parda y abre el mano', () => {
    const state = start4([
      ['3-oro', '5-oro', '6-basto'],
      ['3-copa', '5-copa', '6-oro'],
      ['4-basto', '5-espada', '6-copa'],
      ['4-oro', '5-basto', '6-espada']
    ]);
    const r = run(state, [[A1, 'PLAY_CARD', '3-oro'], [B1, 'PLAY_CARD', '3-copa'], [A2, 'PLAY_CARD', '4-basto'], [B2, 'PLAY_CARD', '4-oro']]);
    expect(r.state.hand.bazas[0].winnerTeam).toBeNull();
    expect(r.state.hand.turnSeat).toBe(0);
  });

  it('empate entre compañeros no es parda: gana su equipo y abre quien la jugó primero', () => {
    const state = start4([
      ['3-oro', '5-oro', '6-basto'],
      ['4-espada', '5-copa', '6-oro'],
      ['3-copa', '5-espada', '6-copa'],
      ['4-oro', '5-basto', '6-espada']
    ]);
    const r = run(state, [[A1, 'PLAY_CARD', '3-oro'], [B1, 'PLAY_CARD', '4-espada'], [A2, 'PLAY_CARD', '3-copa'], [B2, 'PLAY_CARD', '4-oro']]);
    expect(r.state.hand.bazas[0].winnerTeam).toBe(0);
    expect(r.state.hand.turnSeat).toBe(0);
  });

  it('tres pardas: gana el equipo del mano', () => {
    const state = start4([
      ['3-oro', '2-oro', '12-oro'],
      ['3-copa', '2-copa', '12-copa'],
      ['4-basto', '5-espada', '6-copa'],
      ['4-oro', '5-basto', '6-espada']
    ]);
    const r = run(state, [
      [A1, 'PLAY_CARD', '3-oro'], [B1, 'PLAY_CARD', '3-copa'], [A2, 'PLAY_CARD', '4-basto'], [B2, 'PLAY_CARD', '4-oro'],
      [A1, 'PLAY_CARD', '2-oro'], [B1, 'PLAY_CARD', '2-copa'], [A2, 'PLAY_CARD', '5-espada'], [B2, 'PLAY_CARD', '5-basto'],
      [A1, 'PLAY_CARD', '12-oro'], [B1, 'PLAY_CARD', '12-copa'], [A2, 'PLAY_CARD', '6-copa'], [B2, 'PLAY_CARD', '6-espada']
    ]);
    expect(r.state.hand.result).toMatchObject({ winnerTeam: 0, reason: 'bazas' });
  });
});

describe('2 vs 2: quién responde un canto (el rival más mano)', () => {
  it('canta A2 y responde B1 (juega antes que B2); B2 no puede responder', () => {
    const state = start4(LOW);
    const r = run(state, [[A1, 'PLAY_CARD', '4-copa'], [B1, 'PLAY_CARD', '4-espada'], [A2, 'CALL_TRUCO']]);
    expect(r.state.hand.pending.responderSeat).toBe(1);
    expect(getActingPlayerIds(r.state)).toEqual([B1]);
    expect(getAvailableActions(r.state, B2)).toEqual([]);
    expect(() => applyAction(r.state, B2, { type: 'ACCEPT' })).toThrow(expect.objectContaining({ code: 'NOTHING_TO_ANSWER' }));
    expect(() => applyAction(r.state, A1, { type: 'ACCEPT' })).toThrow(expect.objectContaining({ code: 'NOTHING_TO_ANSWER' }));
    expect(projectStateFor(r.state, B2).hand.pending.responderId).toBe(B1);
  });

  it('canta B1 y responde A1 (el mano), aunque ya haya jugado su carta', () => {
    const state = start4(LOW);
    const r = run(state, [[A1, 'PLAY_CARD', '4-copa'], [B1, 'CALL_TRUCO']]);
    expect(getActingPlayerIds(r.state)).toEqual([A1]);
    expect(getAvailableActions(r.state, A2)).toEqual([]);
  });

  it('el que responde puede subir; el retruco lo responde el rival más mano del otro equipo', () => {
    const state = start4(LOW);
    const r = run(state, [[A1, 'CALL_TRUCO'], [B1, 'CALL_RETRUCO']]);
    expect(r.state.hand.truco.level).toBe(2);
    expect(r.state.hand.pending).toMatchObject({ level: 3, callerTeam: 1, responderSeat: 0 });
    const done = run(r.state, [[A1, 'ACCEPT']]);
    expect(done.state.hand.truco).toMatchObject({ level: 3, holderTeam: 0 });
  });

  it('"el quiero" es del equipo: cualquiera de los dos sube en su turno, los rivales no', () => {
    const state = start4(LOW);
    const r = run(state, [[A1, 'CALL_TRUCO'], [B1, 'ACCEPT'], [A1, 'PLAY_CARD', '4-copa']]);
    expect(r.state.hand.truco.holderTeam).toBe(1);
    expect(getAvailableActions(r.state, B1)).toContain('CALL_RETRUCO');
    const after = run(r.state, [[B1, 'PLAY_CARD', '4-espada']]);
    expect(getAvailableActions(after.state, A2)).not.toContain('CALL_RETRUCO');
  });

  it('no quiero: el equipo que cantó suma y termina la mano', () => {
    const state = start4(LOW);
    const r = run(state, [[A1, 'PLAY_CARD', '4-copa'], [B1, 'CALL_TRUCO'], [A1, 'REJECT']]);
    expect(r.state.hand.result).toMatchObject({ winnerTeam: 1, points: 1, reason: 'truco_rejected' });
  });
});

describe('2 vs 2: envido (solo los pies)', () => {
  // Tantos: A1 25, B1 28, A2 33, B2 30
  const TANTOS_HANDS = [
    ['5-oro', '12-oro', '4-copa'],
    ['7-copa', '1-copa', '4-espada'],
    ['7-espada', '6-espada', '10-basto'],
    ['6-basto', '4-basto', '11-oro']
  ];

  it('el mano y su rival siguiente no pueden cantar envido; los pies sí, en su turno', () => {
    const state = start4(TANTOS_HANDS);
    expect(getAvailableActions(state, A1)).not.toContain('CALL_ENVIDO');
    const r1 = run(state, [[A1, 'PLAY_CARD', '4-copa']]);
    expect(getAvailableActions(r1.state, B1)).not.toContain('CALL_ENVIDO');
    const r2 = run(r1.state, [[B1, 'PLAY_CARD', '4-espada']]);
    expect(getAvailableActions(r2.state, A2)).toEqual(expect.arrayContaining(['CALL_ENVIDO', 'CALL_REAL_ENVIDO', 'CALL_FALTA_ENVIDO']));
    const r3 = run(r2.state, [[A2, 'PLAY_CARD', '10-basto']]);
    expect(getAvailableActions(r3.state, B2)).toContain('CALL_ENVIDO');
  });

  it('lo responde el rival más mano, que puede subirlo', () => {
    const state = start4(TANTOS_HANDS);
    const r = run(state, [[A1, 'PLAY_CARD', '4-copa'], [B1, 'PLAY_CARD', '4-espada'], [A2, 'CALL_ENVIDO']]);
    expect(getActingPlayerIds(r.state)).toEqual([B1]);
    expect(getAvailableActions(r.state, B1)).toEqual(expect.arrayContaining(['ACCEPT', 'REJECT', 'CALL_REAL_ENVIDO']));
    expect(getAvailableActions(r.state, B2)).toEqual([]);
  });

  it('canto de tantos desde el mano: canta quien supera estrictamente; los demás "son buenas" o pasan', () => {
    const state = start4(TANTOS_HANDS);
    const r = run(state, [[A1, 'PLAY_CARD', '4-copa'], [B1, 'PLAY_CARD', '4-espada'], [A2, 'CALL_ENVIDO'], [B1, 'ACCEPT']]);
    const result = r.events.find((e) => e.type === 'ENVIDO_RESULT');
    // A1 canta 25, B1 supera con 28, A2 supera con 33, B2 (30) dice "son buenas"
    expect(result).toMatchObject({ accepted: true, winnerTeam: 0, points: 2, tantos: { A1: 25, B1: 28, A2: 33 } });
    expect(result.tantos).not.toHaveProperty(B2);
  });

  it('si su equipo ya va ganando, el compañero pasa y sus tantos no se revelan (ni a su compañero)', () => {
    const hands = [
      ['7-espada', '6-espada', '10-basto'], // A1 33
      ['4-espada', '5-copa', '6-oro'], // B1 6
      ['6-basto', '4-basto', '11-oro'], // A2 30
      ['5-oro', '12-oro', '4-copa'] // B2 25
    ];
    const state = start4(hands);
    const r = run(state, [[A1, 'PLAY_CARD', '10-basto'], [B1, 'PLAY_CARD', '4-espada'], [A2, 'CALL_ENVIDO'], [B1, 'ACCEPT']]);
    const result = r.events.find((e) => e.type === 'ENVIDO_RESULT');
    expect(result.tantos).toEqual({ A1: 33 });
    for (const p of PLAYERS) {
      const view = projectStateFor(r.state, p);
      expect(view.hand.envido.result.tantos).toEqual({ A1: 33 });
    }
  });

  it('"el envido está primero": quien responde el truco puede cantar envido aunque no sea pie', () => {
    const state = start4(TANTOS_HANDS);
    const r = run(state, [[A1, 'CALL_TRUCO']]);
    expect(getActingPlayerIds(r.state)).toEqual([B1]);
    expect(getAvailableActions(r.state, B1)).toContain('CALL_ENVIDO');
    const env = run(r.state, [[B1, 'CALL_ENVIDO']]);
    // Lo responde el rival más mano del equipo A: A1
    expect(env.state.hand.pending).toMatchObject({ kind: 'envido', responderSeat: 0 });
    const done = run(env.state, [[A1, 'ACCEPT']]);
    // Resuelto el envido, el truco vuelve a quedar pendiente para B1
    expect(done.state.hand.pending).toMatchObject({ kind: 'truco', responderSeat: 1 });
  });
});

describe('2 vs 2: mazo y tiempo', () => {
  it('el mazo es del equipo: si se va A2, la mano es de B (con el punto del envido en primera)', () => {
    const state = start4(LOW);
    const r = run(state, [[A1, 'PLAY_CARD', '4-copa'], [B1, 'PLAY_CARD', '4-espada'], [A2, 'GO_TO_DECK']]);
    expect(r.state.hand.result).toMatchObject({ winnerTeam: 1, points: 2, reason: 'deck' });
  });

  it('el que debe responder también puede irse al mazo; su compañero no', () => {
    const state = start4(LOW);
    const r = run(state, [[A1, 'CALL_TRUCO']]);
    expect(getAvailableActions(r.state, B1)).toContain('GO_TO_DECK');
    expect(() => applyAction(r.state, B2, { type: 'GO_TO_DECK' })).toThrow(expect.objectContaining({ code: 'NOT_YOUR_TURN' }));
  });

  it('con un canto pendiente, el tiempo vence para el rival que debe responder ("no quiero")', () => {
    const state = start4(LOW);
    const r = run(state, [[A1, 'PLAY_CARD', '4-copa'], [B1, 'PLAY_CARD', '4-espada'], [A2, 'CALL_TRUCO']]);
    const t = applyTimeout(r.state);
    expect(t.playerId).toBe(B1);
    expect(t.state.hand.result).toMatchObject({ winnerTeam: 0, reason: 'truco_rejected' });
  });

  it('si había que jugar, pierde la mano el equipo del que tenía el turno', () => {
    const state = start4(LOW);
    const r = run(state, [[A1, 'PLAY_CARD', '4-copa']]);
    const t = applyTimeout(r.state);
    expect(t.playerId).toBe(B1);
    expect(t.state.hand.result).toMatchObject({ winnerTeam: 0, reason: 'timeout' });
  });
});

describe('2 vs 2: proyección', () => {
  it('cada jugador ve solo sus cartas; de los otros tres (también del compañero), solo cuántas tiene', () => {
    const state = start4(LOW);
    for (const [seat, p] of PLAYERS.entries()) {
      const view = projectStateFor(state, p);
      expect(view.hand.myCards).toEqual(LOW[seat]);
      const serialized = JSON.stringify(view);
      for (const [other, cards] of LOW.entries()) {
        if (other === seat) continue;
        for (const card of cards) expect(serialized).not.toContain(card);
      }
      expect(view.players.map((x) => x.cardsInHand)).toEqual([3, 3, 3, 3]);
    }
  });
});
