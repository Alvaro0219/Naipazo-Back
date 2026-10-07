// Vuelca la matriz de cantos (src/game/truco/__tests__/matrix.js) en docs/TRUCO_RULES.md, entre los marcadores
// MATRIZ:INICIO y MATRIZ:FIN. Correr después de cambiar la matriz:  npm run rules:matrix
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACTION_LABELS, MATRIX } from '../src/game/truco/__tests__/matrix.js';

const docPath = fileURLToPath(new URL('../docs/TRUCO_RULES.md', import.meta.url));
const ROLE = {
  A: 'mano', B: 'pie', A1: 'A1 (mano)', B1: 'B1', A2: 'A2 (pie de A)', B2: 'B2 (pie de B, reparte)'
};

const rows = MATRIX.map((r) => {
  const cells = Object.entries(r.allowed)
    .map(([player, actions]) => `**${ROLE[player]}**: ${actions.map((a) => ACTION_LABELS[a]).join(', ')}`)
    .join('<br>');
  return `| ${r.id} | ${r.mode === '1v1' ? '1 vs 1' : '2 vs 2'} | ${r.state} | ${cells} |`;
});

const table = [
  '',
  'Generada automáticamente: no editar a mano. En cada estado, **solo** el jugador indicado puede actuar y solo con esas',
  'acciones; cualquier otra acción de cualquier jugador se rechaza (lo verifica `matrix.test.js`, celda por celda).',
  '',
  '| Celda | Modo | Estado | Quién puede actuar y con qué |',
  '|---|---|---|---|',
  ...rows,
  ''
].join('\n');

let doc = readFileSync(docPath, 'utf8');
const crlf = doc.includes('\r\n');
doc = doc.replace(/\r\n/g, '\n');
const start = doc.indexOf('<!-- MATRIZ:INICIO -->');
const end = doc.indexOf('<!-- MATRIZ:FIN -->');
if (start < 0 || end < 0) throw new Error('No encontré los marcadores de la matriz en TRUCO_RULES.md');
doc = `${doc.slice(0, start + '<!-- MATRIZ:INICIO -->'.length)}\n${table}\n${doc.slice(end)}`;
writeFileSync(docPath, crlf ? doc.replace(/\n/g, '\r\n') : doc);
console.log(`Matriz actualizada: ${MATRIX.length} estados`);
