// Pruebas EXHAUSTIVAS del motor contra el oráculo independiente (EXACTITUD_DEL_JUEGO.md, 9.2).
// Cada test lleva en el nombre el identificador de la regla (trazabilidad: npm run rules:trace).
import { describe, expect, it } from 'vitest';
import { ALL_CARD_IDS, trucoRank } from '../cards.js';
import { applyAction, dealNextHand } from '../engine.js';
import { canRaiseEnvido, computeTantos, envidoAcceptedPoints, envidoRejectedPoints } from '../envido.js';
import { bazaWinner, decideHandWinner, faltaEnvidoPoints, scoreSection } from '../scoring.js';
import { createMatchState } from '../state.js';
import { A, B, run, seededRng, startMatch } from './helpers.js';
import * as O from './oracle.js';

const sign = (n) => Math.sign(n);
// El motor: rango mayor = carta más alta. El oráculo: posición menor = más alta.
const engineCompare = (a, b) => sign(trucoRank(b) - trucoRank(a));

describe('cartas y mazo', () => {
  it('R-MAZO-01: 40 cartas distintas, exactamente las del mazo del oráculo', () => {
    expect(ALL_CARD_IDS).toHaveLength(40);
    expect(new Set(ALL_CARD_IDS).size).toBe(40);
    expect([...ALL_CARD_IDS].sort()).toEqual([...O.MAZO].sort());
  });

  it('R-CARTA-01 / R-CARTA-02: los 1.600 pares de cartas se comparan igual que la tabla', () => {
    let pares = 0;
    for (const a of O.MAZO) {
      for (const b of O.MAZO) {
        expect(engineCompare(a, b), `${a} vs ${b}`).toBe(O.comparar(a, b));
        pares += 1;
      }
    }
    expect(pares).toBe(1600);
  });
});

describe('tantos', () => {
  it('R-ENV-01: las 9.880 manos posibles de 3 cartas dan los mismos tantos (y siempre entre 0 y 33)', () => {
    let manos = 0;
    for (let i = 0; i < 40; i++) {
      for (let j = i + 1; j < 40; j++) {
        for (let k = j + 1; k < 40; k++) {
          const mano = [O.MAZO[i], O.MAZO[j], O.MAZO[k]];
          const esperado = O.tantos(mano);
          expect(computeTantos(mano), mano.join(',')).toBe(esperado);
          expect(esperado).toBeGreaterThanOrEqual(0);
          expect(esperado).toBeLessThanOrEqual(33);
          manos += 1;
        }
      }
    }
    expect(manos).toBe(9880);
  });
});

describe('bazas', () => {
  it('R-BAZA-01 / R-BAZA-02: todas las bazas de 1 vs 1 (1.560 pares ordenados, cada uno como primero)', () => {
    let casos = 0;
    for (const a of O.MAZO) {
      for (const b of O.MAZO) {
        if (a === b) continue;
        const jugadas = [{ playerId: 'P0', cardId: a, team: 0 }, { playerId: 'P1', cardId: b, team: 1 }];
        const motor = bazaWinner(jugadas);
        const oraculo = O.ganadorBaza(jugadas.map((x) => ({ jugador: x.playerId, carta: x.cardId, equipo: x.team })));
        expect(motor, `${a} / ${b}`).toEqual({ winnerTeam: oraculo.equipo, winnerPlayerId: oraculo.jugador });
        casos += 1;
      }
    }
    expect(casos).toBe(1560);
  });

  it('R-BAZA-01 / R-BAZA-02 / R-BAZA-03: todas las combinaciones de posiciones de 4 cartas (14⁴), con los dos órdenes de equipos', () => {
    // Para cada combinación de posiciones se eligen cartas distintas de esas posiciones (si no alcanzan, la
    // combinación es imposible: por ejemplo, dos "1 de espada").
    let posibles = 0;
    let imposibles = 0;
    const P = O.POSICIONES.length;
    for (let p0 = 0; p0 < P; p0++) {
      for (let p1 = 0; p1 < P; p1++) {
        for (let p2 = 0; p2 < P; p2++) {
          for (let p3 = 0; p3 < P; p3++) {
            const usadas = new Set();
            const cartas = [p0, p1, p2, p3].map((p) => {
              const libre = O.POSICIONES[p].find((c) => !usadas.has(c));
              if (libre) usadas.add(libre);
              return libre;
            });
            if (cartas.includes(undefined)) { imposibles += 1; continue; }
            for (const equipos of [[0, 1, 0, 1], [1, 0, 1, 0]]) {
              const jugadas = cartas.map((c, i) => ({ playerId: `S${i}`, cardId: c, team: equipos[i] }));
              const oraculo = O.ganadorBaza(jugadas.map((x) => ({ jugador: x.playerId, carta: x.cardId, equipo: x.team })));
              expect(bazaWinner(jugadas), cartas.join(',')).toEqual({ winnerTeam: oraculo.equipo, winnerPlayerId: oraculo.jugador });
            }
            posibles += 1;
          }
        }
      }
    }
    expect(posibles + imposibles).toBe(14 ** 4);
    expect(posibles).toBeGreaterThan(30000);
  });
});

describe('ganador de la mano', () => {
  it('R-MANO-01 / R-MANO-02: todas las secuencias de resultados de bazas, con cada equipo como mano', () => {
    const valores = [0, 1, null];
    let casos = 0;
    for (const mano of [0, 1]) {
      const secuencias = [[]];
      for (let largo = 1; largo <= 3; largo++) {
        for (const prefijo of secuencias.filter((s) => s.length === largo - 1)) {
          // Una secuencia solo sigue si la mano todavía no estaba decidida (R-MANO-02: no hay bazas innecesarias)
          if (prefijo.length && O.ganadorMano(prefijo, mano) !== undefined) continue;
          for (const v of valores) secuencias.push([...prefijo, v]);
        }
      }
      for (const s of secuencias.filter((x) => x.length)) {
        expect(decideHandWinner(s, mano), `${JSON.stringify(s)} mano ${mano}`).toBe(O.ganadorMano(s, mano));
        casos += 1;
      }
      // Con 3 bazas la mano siempre queda decidida
      for (const s of secuencias.filter((x) => x.length === 3)) expect(decideHandWinner(s, mano)).not.toBeUndefined();
    }
    expect(casos).toBeGreaterThan(20);
  });
});

const CANTO = { E: 'ENVIDO', R: 'REAL_ENVIDO', F: 'FALTA_ENVIDO' };
const ACCION = { E: 'CALL_ENVIDO', R: 'CALL_REAL_ENVIDO', F: 'CALL_FALTA_ENVIDO' };

describe('envido: combinaciones y puntos', () => {
  it('R-ENV-02: el motor permite exactamente las 11 secuencias de la tabla (todas las de hasta 5 cantos revisadas)', () => {
    const permitidas = new Set(O.SECUENCIAS_ENVIDO.map((s) => s.cantos.join('')));
    const todas = [['E'], ['R'], ['F']];
    for (let i = 0; i < todas.length; i++) if (todas[i].length < 5) for (const c of 'ERF') todas.push([...todas[i], c]);
    let revisadas = 0;
    for (const seq of todas) {
      let valida = true;
      for (let k = 1; k < seq.length; k++) {
        if (!canRaiseEnvido(seq.slice(0, k).map((c) => CANTO[c]), CANTO[seq[k]])) valida = false;
      }
      expect(valida, seq.join('')).toBe(permitidas.has(seq.join('')));
      revisadas += 1;
    }
    expect(revisadas).toBe(3 + 9 + 27 + 81 + 243);
  });

  it('R-ENV-02 / R-ENV-04: puntos queridos y no queridos de cada secuencia, con la falta para todos los marcadores', () => {
    for (const { cantos, querido, noQuerido } of O.SECUENCIAS_ENVIDO) {
      const calls = cantos.map((c) => CANTO[c]);
      expect(envidoRejectedPoints(calls), cantos.join('')).toBe(noQuerido);
      for (const objetivo of [15, 30]) {
        for (let a = 0; a < objetivo; a++) {
          for (let b = 0; b < objetivo; b++) {
            const f = O.falta([a, b], objetivo);
            const esperado = querido === 'falta' ? f : querido;
            expect(envidoAcceptedPoints(calls, faltaEnvidoPoints([a, b], objetivo))).toBe(esperado);
          }
        }
      }
    }
  });

  it('R-ENV-04: falta envido para todos los pares de puntajes a 15 y a 30', () => {
    let casos = 0;
    for (const objetivo of [15, 30]) {
      for (let a = 0; a < objetivo; a++) {
        for (let b = 0; b < objetivo; b++) {
          expect(faltaEnvidoPoints([a, b], objetivo), `${a}-${b} a ${objetivo}`).toBe(O.falta([a, b], objetivo));
          casos += 1;
        }
      }
    }
    expect(casos).toBe(15 * 15 + 30 * 30);
  });

  it('R-PUNT-03: malas y buenas en todos los puntajes (con 15 justos se sigue en malas)', () => {
    for (const objetivo of [15, 30]) {
      for (let p = 0; p <= objetivo; p++) expect(scoreSection(p, objetivo), `${p} a ${objetivo}`).toBe(O.seccion(p, objetivo));
    }
  });

  it('R-ENV-02: jugando con el motor, cada secuencia querida y no querida suma lo de la tabla a quien corresponde', () => {
    // A (mano) abre; se alternan los cantos; el último en responder quiere o no quiere.
    const manoA = ['7-espada', '6-espada', '4-copa']; // 33
    const pieB = ['4-basto', '5-oro', '6-copa']; // 6
    for (const { cantos, querido, noQuerido } of O.SECUENCIAS_ENVIDO) {
      for (const quiere of [true, false]) {
        for (const marcador of [[0, 0], [3, 9], [12, 14], [14, 0]]) {
          const state = startMatch({ targetPoints: 15, mano: manoA, pie: pieB, score: marcador });
          const pasos = cantos.map((c, i) => [i % 2 === 0 ? A : B, ACCION[c]]);
          const respondedor = cantos.length % 2 === 0 ? A : B;
          const r = run(state, [...pasos, [respondedor, quiere ? 'ACCEPT' : 'REJECT']]);
          const evento = r.events.find((e) => e.type === 'POINTS' && e.reason === 'envido');
          const cantor = cantos.length % 2 === 1 ? 0 : 1; // equipo del último que cantó
          if (quiere) {
            expect(evento.points).toBe(querido === 'falta' ? O.falta(marcador, 15) : querido);
            expect(evento.team).toBe(0); // A tiene 33 tantos
          } else {
            expect(evento).toMatchObject({ points: noQuerido, team: cantor });
          }
        }
      }
    }
  });
});

describe('truco y mazo', () => {
  const MANO = ['4-copa', '5-oro', '6-basto'];
  const PIE = ['4-espada', '5-copa', '6-oro'];
  const NIVELES = { 2: 'CALL_TRUCO', 3: 'CALL_RETRUCO', 4: 'CALL_VALE_CUATRO' };

  it('R-TRUCO-01 / R-TRUCO-05: cada nivel no querido suma lo de la tabla a quien cantó', () => {
    for (const nivel of [2, 3, 4]) {
      const pasos = [];
      for (let l = 2; l <= nivel; l++) pasos.push([l % 2 === 0 ? A : B, NIVELES[l]]);
      const respondedor = nivel % 2 === 0 ? B : A;
      const r = run(startMatch({ mano: MANO, pie: PIE }), [...pasos, [respondedor, 'REJECT']]);
      const cantor = nivel % 2 === 0 ? 0 : 1;
      expect(r.state.hand.result, `nivel ${nivel}`).toMatchObject({ winnerTeam: cantor, points: O.TRUCO[nivel].noQuerido, reason: 'truco_rejected' });
    }
  });

  it('R-TRUCO-05 / R-MAZO-IR-01: querido, la mano vale el nivel (lo cobra el rival de quien se va al mazo)', () => {
    for (const nivel of [2, 3, 4]) {
      const pasos = [];
      for (let l = 2; l <= nivel; l++) pasos.push([l % 2 === 0 ? A : B, NIVELES[l]]);
      const respondedor = nivel % 2 === 0 ? B : A;
      // Querido el truco ya no hay punto extra de envido: el que tiene el turno (A, el mano) se va al mazo
      const r = run(startMatch({ mano: MANO, pie: PIE }), [...pasos, [respondedor, 'ACCEPT'], [A, 'GO_TO_DECK']]);
      expect(r.state.hand.result, `nivel ${nivel}`).toMatchObject({ winnerTeam: 1, points: O.TRUCO[nivel].querido, reason: 'deck' });
    }
  });

  it('R-MAZO-IR-01: mazo sin cantos vale 1, más 1 en la primera baza si el envido todavía se podía cantar', () => {
    const primera = run(startMatch({ mano: MANO, pie: PIE }), [[A, 'GO_TO_DECK']]);
    expect(primera.state.hand.result).toMatchObject({ winnerTeam: 1, points: O.TRUCO[1].querido + 1 });

    const conEnvidoResuelto = run(startMatch({ mano: MANO, pie: PIE }), [[A, 'CALL_ENVIDO'], [B, 'REJECT'], [A, 'GO_TO_DECK']]);
    expect(conEnvidoResuelto.state.hand.result).toMatchObject({ winnerTeam: 1, points: 1 });

    const segunda = run(startMatch({ mano: MANO, pie: PIE }), [[A, 'PLAY_CARD', '4-copa'], [B, 'PLAY_CARD', '6-oro'], [B, 'GO_TO_DECK']]);
    expect(segunda.state.hand.result).toMatchObject({ winnerTeam: 0, points: 1 });
  });
});

describe('canto de los tantos', () => {
  const PLAYERS_2V2 = ['A1', 'B1', 'A2', 'B2'];

  it('R-ENV-05: 1 vs 1 en 5.000 repartos al azar (con semilla): revela y gana lo mismo que el oráculo', () => {
    const rng = seededRng(2024);
    for (let n = 0; n < 5000; n++) {
      const mazo = [...O.MAZO];
      for (let i = mazo.length - 1; i > 0; i--) { const j = rng(i + 1); [mazo[i], mazo[j]] = [mazo[j], mazo[i]]; }
      const initial = createMatchState({ config: { targetPoints: 30 }, playerIds: [A, B], dealerSeat: 1 });
      const { state } = dealNextHand(initial, mazo);
      const r = run(state, [[A, 'CALL_ENVIDO'], [B, 'ACCEPT']]);
      const res = r.events.find((e) => e.type === 'ENVIDO_RESULT');
      const esperado = O.cantoDeTantos([A, B].map((id, seat) => ({ id, equipo: seat % 2, tantos: O.tantos(state.hand.dealt[id]) })));
      expect(res.tantos).toEqual(esperado.revelados);
      expect(res.winnerTeam).toBe(esperado.ganador);
    }
  });

  it('R-ENV-06: 2 vs 2 en 5.000 repartos al azar: revela y gana lo mismo que el oráculo (nadie más ve tantos)', () => {
    const rng = seededRng(77);
    for (let n = 0; n < 5000; n++) {
      const mazo = [...O.MAZO];
      for (let i = mazo.length - 1; i > 0; i--) { const j = rng(i + 1); [mazo[i], mazo[j]] = [mazo[j], mazo[i]]; }
      const initial = createMatchState({ config: { targetPoints: 30 }, playerIds: PLAYERS_2V2, dealerSeat: 3 });
      const { state } = dealNextHand(initial, mazo);
      const [c0, c1] = [state.hand.cards.A1[0], state.hand.cards.B1[0]];
      // A1 y B1 juegan; A2 (pie) canta envido; responde B1 (el rival más mano) queriendo
      const r = run(state, [['A1', 'PLAY_CARD', c0], ['B1', 'PLAY_CARD', c1], ['A2', 'CALL_ENVIDO'], ['B1', 'ACCEPT']]);
      const res = r.events.find((e) => e.type === 'ENVIDO_RESULT');
      const esperado = O.cantoDeTantos(PLAYERS_2V2.map((id, seat) => ({ id, equipo: seat % 2, tantos: O.tantos(state.hand.dealt[id]) })));
      expect(res.tantos).toEqual(esperado.revelados);
      expect(res.winnerTeam).toBe(esperado.ganador);
      void applyAction;
    }
  });
});
