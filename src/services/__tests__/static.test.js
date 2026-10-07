// Chequeos estáticos del código fuente (sin base de datos): reglas que se garantizan por cómo está escrito el código.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = fileURLToPath(new URL('../..', import.meta.url));
function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return name.endsWith('.js') ? [path] : [];
  });
}
const files = sources(src).map((path) => ({ path, rel: path.slice(src.length).replace(/\\/g, '/'), code: readFileSync(path, 'utf8') }));

describe('código fuente', () => {
  it('R-REP-03: el primer repartidor se sortea con crypto.randomInt', () => {
    const matchService = files.find((f) => f.rel.endsWith('services/matchService.js')).code;
    expect(matchService).toMatch(/import \{ randomInt \} from 'node:crypto'/);
    expect(matchService).toMatch(/dealerSeat: randomInt\(players\.length\)/);
  });

  it('R-MAZO-02: ningún archivo del backend usa Math.random', () => {
    const offenders = files.filter((f) => /Math\.random\s*\(/.test(f.code)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('R-ECO-09: solo walletService modifica User.balance (I-E7)', () => {
    // Escrituras de saldo: $inc / $set sobre balance, o asignaciones a .balance
    const write = /\$inc\s*:\s*\{[^}]*\bbalance\b|\$set\s*:\s*\{[^}]*\bbalance\b|\.balance\s*[+\-*/]?=(?!=)/;
    const offenders = files.filter((f) => write.test(f.code) && !f.rel.endsWith('services/walletService.js')).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
