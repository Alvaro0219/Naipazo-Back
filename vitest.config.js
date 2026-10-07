import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.js'],
    testTimeout: 30000,
    hookTimeout: 60000,
    // Los tests de integración comparten la misma base: correr archivos en serie
    fileParallelism: false,
    // npm run test:coverage: el motor tiene que quedar al 100 % (EXACTITUD_DEL_JUEGO.md, 9.1)
    coverage: {
      provider: 'v8',
      include: ['src/game/truco/*.js'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 }
    }
  }
});
