// El detector de invariantes tiene que SALTAR ante estados rotos (si no, las propiedades no prueban nada).
import { describe, expect, it } from 'vitest';
import { checkInvariants } from '../invariants.js';
import { A, B, run, startMatch } from './helpers.js';

const MANO = ['4-copa', '5-oro', '6-basto'];
const PIE = ['4-espada', '5-copa', '6-oro'];
const ids = (state, prev) => checkInvariants(state, prev).map((x) => x.id);

describe('detector de invariantes', () => {
  it('R-TURNO-01: un estado sano no tiene violaciones', () => {
    const s = startMatch({ mano: MANO, pie: PIE });
    expect(checkInvariants(s)).toEqual([]);
    const r = run(s, [[A, 'PLAY_CARD', '4-copa'], [B, 'CALL_TRUCO']]);
    expect(checkInvariants(r.state, s)).toEqual([]);
  });

  it('R-PUNT-01: detecta un puntaje que baja, que no es entero o que pasa el objetivo', () => {
    const s = startMatch({ mano: MANO, pie: PIE, score: [5, 3] });
    expect(ids({ ...s, score: [4, 3] }, s)).toContain('I-P1');
    expect(ids({ ...s, score: [5.5, 3] }, s)).toContain('I-P1');
    expect(ids({ ...s, score: [16, 3] })).toContain('I-P1');
  });

  it('R-FIN-02: detecta una partida que sigue con un equipo en el objetivo, o terminada sin ganador', () => {
    const s = startMatch({ mano: MANO, pie: PIE });
    expect(ids({ ...s, score: [15, 3] })).toContain('I-P3');
    expect(ids({ ...s, phase: 'finished', winnerTeam: null, endReason: 'normal' })).toContain('R-FIN-02');
  });

  it('R-REP-01: detecta cartas repetidas, perdidas o que no salieron del mazo', () => {
    const s = startMatch({ mano: MANO, pie: PIE });
    const dup = structuredClone(s);
    dup.hand.cards[B] = ['4-copa', '5-copa', '6-oro'];
    dup.hand.dealt[B] = ['4-copa', '5-copa', '6-oro'];
    expect(ids(dup)).toContain('I-C2');
    const lost = structuredClone(s);
    lost.hand.cards[A] = ['4-copa', '5-oro'];
    expect(ids(lost)).toContain('I-C2');
  });

  it('R-TURNO-01: detecta dos jugadas del mismo jugador en una baza y un truco que baja', () => {
    const s = run(startMatch({ mano: MANO, pie: PIE }), [[A, 'CALL_TRUCO'], [B, 'ACCEPT']]).state;
    const twice = structuredClone(s);
    twice.hand.bazas[0].plays = [{ playerId: A, cardId: '4-copa' }, { playerId: A, cardId: '5-oro' }];
    twice.hand.cards[A] = ['6-basto'];
    expect(ids(twice)).toContain('I-C4');
    const lower = structuredClone(s);
    lower.hand.truco.level = 1;
    expect(ids(lower, s)).toContain('I-T3');
  });
});
