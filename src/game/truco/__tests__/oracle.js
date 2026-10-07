// Oráculo: implementación de REFERENCIA de las reglas, escrita directamente desde las tablas de
// docs/TRUCO_RULES.md y EXACTITUD_DEL_JUEGO.md. A propósito NO importa nada del motor ni copia su código:
// las pruebas exhaustivas comparan el motor contra esto. Si una tabla cambia, se cambia acá a mano.

export const PALOS = ['espada', 'basto', 'oro', 'copa'];
export const NUMEROS = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12];
export const MAZO = PALOS.flatMap((palo) => NUMEROS.map((n) => `${n}-${palo}`));

// R-CARTA-01: posición en la jerarquía (1 = la más alta), tal como la tabla del documento
const POSICION = new Map();
const tabla = [
  ['1-espada'],
  ['1-basto'],
  ['7-espada'],
  ['7-oro'],
  PALOS.map((p) => `3-${p}`),
  PALOS.map((p) => `2-${p}`),
  ['1-copa', '1-oro'],
  PALOS.map((p) => `12-${p}`),
  PALOS.map((p) => `11-${p}`),
  PALOS.map((p) => `10-${p}`),
  ['7-copa', '7-basto'],
  PALOS.map((p) => `6-${p}`),
  PALOS.map((p) => `5-${p}`),
  PALOS.map((p) => `4-${p}`)
];
tabla.forEach((cartas, i) => cartas.forEach((c) => POSICION.set(c, i + 1)));
export const POSICIONES = tabla;

export function posicion(carta) {
  if (!POSICION.has(carta)) throw new Error(`carta fuera del mazo: ${carta}`);
  return POSICION.get(carta);
}

/** -1 si a gana, 1 si gana b, 0 si empatan (posición menor = más alta). */
export function comparar(a, b) {
  return Math.sign(posicion(a) - posicion(b));
}

// R-ENV-01: tantos de una mano de 3 cartas
export function tantos(cartas) {
  const valor = (c) => { const n = Number(c.split('-')[0]); return n >= 10 ? 0 : n; };
  let mejor = 0;
  for (const palo of PALOS) {
    const delPalo = cartas.filter((c) => c.endsWith(`-${palo}`)).map(valor).sort((x, y) => y - x);
    if (delPalo.length >= 2) mejor = Math.max(mejor, 20 + delPalo[0] + delPalo[1]);
  }
  if (mejor === 0) mejor = Math.max(...cartas.map(valor));
  return mejor;
}

/**
 * R-BAZA-01..03: jugadas en orden [{ jugador, carta, equipo }] → { equipo, jugador } (equipo null = parda).
 */
export function ganadorBaza(jugadas) {
  let mejores = [];
  for (const j of jugadas) {
    if (!mejores.length || comparar(j.carta, mejores[0].carta) < 0) mejores = [j];
    else if (comparar(j.carta, mejores[0].carta) === 0) mejores.push(j);
  }
  const equipos = new Set(mejores.map((m) => m.equipo));
  if (equipos.size > 1) return { equipo: null, jugador: null };
  return { equipo: mejores[0].equipo, jugador: mejores[0].jugador };
}

/**
 * R-MANO-01/02: resultados de bazas (0, 1 o null = parda) → equipo ganador, o undefined si todavía no está
 * determinado. Implementado como la tabla del documento, recorriendo los casos uno por uno.
 */
export function ganadorMano(r, equipoMano) {
  const [b1, b2, b3] = r;
  if (r.length === 1) return undefined;
  // dos primeras
  if (b1 !== null && b1 === b2) return b1; // A A
  if (b1 !== null && b2 === null) return b1; // A P
  if (b1 === null && b2 !== null) return b2; // P A
  if (r.length === 2) return undefined; // A B, P P
  if (b1 !== null && b2 !== null) return b3 === null ? b1 : b3; // A B x
  return b3 === null ? equipoMano : b3; // P P x
}

// R-ENV-02: la lista cerrada de secuencias permitidas, con sus puntos (F = falta envido)
export const SECUENCIAS_ENVIDO = [
  { cantos: ['E'], querido: 2, noQuerido: 1 },
  { cantos: ['E', 'E'], querido: 4, noQuerido: 2 },
  { cantos: ['R'], querido: 3, noQuerido: 1 },
  { cantos: ['E', 'R'], querido: 5, noQuerido: 2 },
  { cantos: ['E', 'E', 'R'], querido: 7, noQuerido: 4 },
  { cantos: ['F'], querido: 'falta', noQuerido: 1 },
  { cantos: ['E', 'F'], querido: 'falta', noQuerido: 2 },
  { cantos: ['E', 'E', 'F'], querido: 'falta', noQuerido: 4 },
  { cantos: ['R', 'F'], querido: 'falta', noQuerido: 3 },
  { cantos: ['E', 'R', 'F'], querido: 'falta', noQuerido: 5 },
  { cantos: ['E', 'E', 'R', 'F'], querido: 'falta', noQuerido: 7 }
];

/** R-ENV-04: falta envido según el marcador [a, b] y los puntos objetivo (D-1: con 15 justos se sigue en malas). */
export function falta([a, b], objetivo) {
  const lider = Math.max(a, b);
  if (objetivo === 15) return 15 - lider;
  if (lider < 15) return 15 - lider; // en malas, todavía sin completarlas
  return 30 - lider; // 15 justos (malas completas) o en buenas
}

/** R-PUNT-03 / D-1 */
export function seccion(puntos, objetivo) {
  if (objetivo !== 30) return null;
  return puntos <= 15 ? 'malas' : 'buenas';
}

/** Tabla del truco: lo que vale la mano querida en cada nivel, y lo que suma quien cantó si no se quiere. */
export const TRUCO = { 1: { querido: 1 }, 2: { querido: 2, noQuerido: 1 }, 3: { querido: 3, noQuerido: 2 }, 4: { querido: 4, noQuerido: 3 } };

/**
 * R-ENV-05 / R-ENV-06: canto de los tantos. `jugadores` en el orden del canto (desde el mano), cada uno
 * { id, equipo, tantos }. Devuelve { revelados: { id: tantos }, ganador: equipo }.
 */
export function cantoDeTantos(jugadores) {
  const revelados = {};
  let mejor = null;
  for (const j of jugadores) {
    if (mejor === null) {
      revelados[j.id] = j.tantos;
      mejor = j;
    } else if (j.equipo !== mejor.equipo && j.tantos > mejor.tantos) {
      revelados[j.id] = j.tantos;
      mejor = j;
    }
    // si no: su equipo ya gana (pasa) o dice "son buenas": no se revela
  }
  return { revelados, ganador: mejor.equipo };
}
