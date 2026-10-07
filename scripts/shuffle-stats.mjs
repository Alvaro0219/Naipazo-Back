// Prueba estadística del barajado (EXACTITUD_DEL_JUEGO.md, 9.5). Fuera de la suite rápida: npm run test:shuffle
// Baraja N veces con shuffleDeck (crypto.randomInt) y cuenta en qué posición cae cada carta. Con un barajado uniforme,
// cada una de las 1.600 combinaciones carta × posición aparece N/40 veces. Chi cuadrado con (40-1)² grados de libertad.
// Control: el mismo test sobre un barajado ingenuo (con sesgo conocido) TIENE que fallar; si no, el test no detecta nada.
// SHUFFLE_N cambia la cantidad (por defecto 5.000.000).
import { randomInt } from 'node:crypto';
import { ALL_CARD_IDS } from '../src/game/truco/cards.js';
import { shuffleDeck } from '../src/game/truco/deck.js';

const N = Number(process.env.SHUFFLE_N || 5_000_000);
const SIZE = ALL_CARD_IDS.length;
const index = new Map(ALL_CARD_IDS.map((c, i) => [c, i]));

/** Barajado ingenuo: intercambia cada posición con CUALQUIERA (no con las que quedan). Sesgado a propósito. */
function naiveShuffle() {
  const d = [...ALL_CARD_IDS];
  for (let i = 0; i < SIZE; i++) {
    const j = randomInt(SIZE);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function measure(shuffle, n) {
  const counts = Array.from({ length: SIZE }, () => new Float64Array(SIZE));
  const start = Date.now();
  for (let k = 0; k < n; k++) {
    const deck = shuffle();
    for (let pos = 0; pos < SIZE; pos++) counts[index.get(deck[pos])][pos] += 1;
  }
  const expected = n / SIZE;
  let chi = 0;
  let worst = 0;
  for (const row of counts) {
    for (const observed of row) {
      chi += (observed - expected) ** 2 / expected;
      worst = Math.max(worst, Math.abs(observed - expected) / Math.sqrt(expected));
    }
  }
  const dof = (SIZE - 1) ** 2;
  // Aproximación normal del chi cuadrado (gl grande): z = (χ² − gl) / √(2·gl)
  const z = (chi - dof) / Math.sqrt(2 * dof);
  // Umbrales amplios para no fallar por azar (|z| > 4 ≈ p < 0,0001; una celda a más de 5,5 desvíos)
  return { chi, dof, z, worst, ok: Math.abs(z) < 4 && worst < 5.5, seconds: (Date.now() - start) / 1000 };
}

const real = measure(() => shuffleDeck(), N);
console.log(`Barajados: ${N.toLocaleString('es-AR')} en ${real.seconds.toFixed(1)} s`);
console.log(`Chi cuadrado: ${real.chi.toFixed(1)} con ${real.dof} grados de libertad (z = ${real.z.toFixed(2)})`);
console.log(`Peor celda carta × posición: ${real.worst.toFixed(2)} desvíos estándar`);
console.log(real.ok ? 'OK: no hay evidencia de sesgo.' : 'FALLA: el barajado no parece uniforme.');

const control = measure(naiveShuffle, Math.min(N, 1_000_000));
console.log(`Control (barajado ingenuo): z = ${control.z.toFixed(1)} → ${control.ok ? 'NO detectado: el test no sirve' : 'detectado, como corresponde'}`);

process.exit(real.ok && !control.ok ? 0 : 1);
