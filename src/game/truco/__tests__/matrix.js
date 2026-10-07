// Matriz de cantos (EXACTITUD_DEL_JUEGO.md, sección 5): estado de la mano × jugador → acciones permitidas.
// Escrita A MANO desde docs/TRUCO_RULES.md, sin consultar al motor. matrix.test.js arma cada estado con el motor
// (pasos desde un reparto fijo) y compara celda por celda; `npm run rules:matrix` la vuelca en TRUCO_RULES.md.
// Todo jugador que no figura en `allowed` no puede hacer nada en ese estado.

export const PLAY = 'PLAY_CARD';
export const T = 'CALL_TRUCO';
export const RT = 'CALL_RETRUCO';
export const V4 = 'CALL_VALE_CUATRO';
export const E = 'CALL_ENVIDO';
export const RE = 'CALL_REAL_ENVIDO';
export const FE = 'CALL_FALTA_ENVIDO';
export const Q = 'ACCEPT';
export const NQ = 'REJECT';
export const M = 'GO_TO_DECK';
const ENV = [E, RE, FE];

// 1 vs 1: A es mano (asiento 0), B es pie. Cartas fijas: A ['4-copa','5-oro','6-basto'], B ['4-espada','5-copa','6-oro'].
// En 2 vs 2: A1 mano, B1, A2 (pie de A), B2 (reparte, pie de B). Cada uno con cartas bajas fijas.
export const MATRIX = [
  // ── 1 vs 1: primera baza
  { id: 'M1', mode: '1v1', state: '1.ª baza, nadie jugó (turno del mano)', steps: [], allowed: { A: [PLAY, T, ...ENV, M] } },
  { id: 'M2', mode: '1v1', state: '1.ª baza, ya jugó el mano (turno del pie)', steps: [['A', PLAY, 0]], allowed: { B: [PLAY, T, ...ENV, M] } },
  { id: 'M3', mode: '1v1', state: 'Truco cantado, pendiente, envido todavía posible', steps: [['A', T]], allowed: { B: [Q, NQ, RT, ...ENV, M] } },
  { id: 'M4', mode: '1v1', state: 'Truco querido (el quiero es del pie); turno del mano', steps: [['A', T], ['B', Q]], allowed: { A: [PLAY, M] } },
  { id: 'M5', mode: '1v1', state: 'Truco querido (el quiero es del pie); turno del pie', steps: [['A', T], ['B', Q], ['A', PLAY, 0]], allowed: { B: [PLAY, RT, M] } },
  { id: 'M6', mode: '1v1', state: 'Retruco pendiente', steps: [['A', T], ['B', RT]], allowed: { A: [Q, NQ, V4, M] } },
  { id: 'M7', mode: '1v1', state: 'Retruco querido (el quiero es del mano); turno del mano', steps: [['A', T], ['B', RT], ['A', Q]], allowed: { A: [PLAY, V4, M] } },
  { id: 'M8', mode: '1v1', state: 'Vale cuatro pendiente', steps: [['A', T], ['B', RT], ['A', V4]], allowed: { B: [Q, NQ, M] } },
  { id: 'M9', mode: '1v1', state: 'Vale cuatro querido; turno del mano', steps: [['A', T], ['B', RT], ['A', V4], ['B', Q]], allowed: { A: [PLAY, M] } },
  { id: 'M10', mode: '1v1', state: 'Envido pendiente', steps: [['A', E]], allowed: { B: [Q, NQ, E, RE, FE, M] } },
  { id: 'M11', mode: '1v1', state: 'Envido, envido pendiente', steps: [['A', E], ['B', E]], allowed: { A: [Q, NQ, RE, FE, M] } },
  { id: 'M12', mode: '1v1', state: 'Real envido pendiente', steps: [['A', RE]], allowed: { B: [Q, NQ, FE, M] } },
  { id: 'M13', mode: '1v1', state: 'Envido, envido, real envido pendiente', steps: [['A', E], ['B', E], ['A', RE]], allowed: { B: [Q, NQ, FE, M] } },
  { id: 'M14', mode: '1v1', state: 'Falta envido pendiente', steps: [['A', FE]], allowed: { B: [Q, NQ, M] } },
  { id: 'M15', mode: '1v1', state: 'Envido resuelto; turno del mano en la 1.ª baza', steps: [['A', E], ['B', NQ]], allowed: { A: [PLAY, T, M] } },
  { id: 'M16', mode: '1v1', state: '"El envido está primero": el pie respondió el truco con envido', steps: [['A', T], ['B', E]], allowed: { A: [Q, NQ, E, RE, FE, M] } },
  { id: 'M17', mode: '1v1', state: 'Resuelto ese envido, el truco vuelve a estar pendiente para el pie', steps: [['A', T], ['B', E], ['A', Q]], allowed: { B: [Q, NQ, RT, M] } },
  { id: 'M18', mode: '1v1', state: 'Truco querido en la 1.ª baza: ya no hay envido', steps: [['A', PLAY, 0], ['B', T], ['A', Q]], allowed: { B: [PLAY, M] } },
  // ── 1 vs 1: segunda baza (A gana la primera con el 5-oro contra el 4-espada)
  { id: 'M19', mode: '1v1', state: '2.ª baza, turno del que ganó la 1.ª', steps: [['A', PLAY, 1], ['B', PLAY, 0]], allowed: { A: [PLAY, T, M] } },
  { id: 'M20', mode: '1v1', state: '2.ª baza, truco cantado: no se puede anteponer el envido', steps: [['A', PLAY, 1], ['B', PLAY, 0], ['A', T]], allowed: { B: [Q, NQ, RT, M] } },
  // ── 2 vs 2
  { id: 'M21', mode: '2v2', state: '1.ª baza, nadie jugó (turno del mano, que no es pie)', steps: [], allowed: { A1: [PLAY, T, M] } },
  { id: 'M22', mode: '2v2', state: '1.ª baza, jugó el mano (turno del rival, que no es pie)', steps: [['A1', PLAY, 0]], allowed: { B1: [PLAY, T, M] } },
  { id: 'M23', mode: '2v2', state: '1.ª baza, turno del pie del equipo mano', steps: [['A1', PLAY, 0], ['B1', PLAY, 0]], allowed: { A2: [PLAY, T, ...ENV, M] } },
  { id: 'M24', mode: '2v2', state: '1.ª baza, jugaron todos menos uno (turno del otro pie)', steps: [['A1', PLAY, 0], ['B1', PLAY, 0], ['A2', PLAY, 0]], allowed: { B2: [PLAY, T, ...ENV, M] } },
  { id: 'M25', mode: '2v2', state: 'Truco del pie A2: responde solo el rival más mano (B1); su compañero no', steps: [['A1', PLAY, 0], ['B1', PLAY, 0], ['A2', T]], allowed: { B1: [Q, NQ, RT, ...ENV, M] } },
  { id: 'M26', mode: '2v2', state: 'Envido del pie A2: responde solo B1', steps: [['A1', PLAY, 0], ['B1', PLAY, 0], ['A2', E]], allowed: { B1: [Q, NQ, E, RE, FE, M] } },
  { id: 'M27', mode: '2v2', state: 'Truco del mano A1 antes de jugar: responde B1, que no es pie pero puede anteponer el envido', steps: [['A1', T]], allowed: { B1: [Q, NQ, RT, ...ENV, M] } },
  { id: 'M28', mode: '2v2', state: 'Truco querido por B; turno de A1: puede jugar o irse, no subir (el quiero es de B)', steps: [['A1', T], ['B1', Q]], allowed: { A1: [PLAY, M] } }
];

export const ACTION_LABELS = {
  [PLAY]: 'jugar carta', [T]: 'truco', [RT]: 'retruco', [V4]: 'vale cuatro', [E]: 'envido', [RE]: 'real envido',
  [FE]: 'falta envido', [Q]: 'quiero', [NQ]: 'no quiero', [M]: 'mazo'
};
