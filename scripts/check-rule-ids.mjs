// Trazabilidad de reglas (EXACTITUD_DEL_JUEGO.md, sección 3): cada identificador R-… de docs/TRUCO_RULES.md
// tiene que aparecer en el NOMBRE de al menos un test (it/test/describe). Sale con código 1 si falta alguno.
//   node scripts/check-rule-ids.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const rulesDoc = readFileSync(join(root, 'docs/TRUCO_RULES.md'), 'utf8');

// Identificadores definidos: primera columna de las tablas ("| R-XXX-NN |")
const defined = [...rulesDoc.matchAll(/^\|\s*(R-[A-Z]+(?:-[A-Z]+)*-\d{2})\s*\|/gm)].map((m) => m[1]);
const unique = [...new Set(defined)];
const duplicated = defined.filter((id, i) => defined.indexOf(id) !== i);

function testFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : testFiles(path);
    return name.endsWith('.test.js') ? [path] : [];
  });
}

// Títulos de tests: el primer argumento string/template de it(, test(, describe( (incluido .each)
const titles = [];
for (const file of testFiles(join(root, 'src'))) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\b(?:it|test|describe)(?:\.each\([^)]*\))?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gs)) {
    titles.push(m[2]);
  }
}

const covered = new Map(unique.map((id) => [id, 0]));
for (const title of titles) {
  for (const id of title.match(/R-[A-Z]+(?:-[A-Z]+)*-\d{2}/g) || []) {
    if (covered.has(id)) covered.set(id, covered.get(id) + 1);
  }
}

const missing = [...covered].filter(([, n]) => n === 0).map(([id]) => id);
const unknown = [...new Set(titles.flatMap((t) => t.match(/R-[A-Z]+(?:-[A-Z]+)*-\d{2}/g) || []))].filter((id) => !covered.has(id));

console.log(`Reglas: ${unique.length} · con tests: ${unique.length - missing.length} · sin tests: ${missing.length}`);
if (duplicated.length) console.log(`Identificadores repetidos en TRUCO_RULES.md: ${duplicated.join(', ')}`);
if (unknown.length) console.log(`Tests que citan reglas que no existen: ${unknown.join(', ')}`);
if (missing.length) console.log(`Sin tests: ${missing.join(', ')}`);
process.exit(missing.length || duplicated.length || unknown.length ? 1 : 0);
