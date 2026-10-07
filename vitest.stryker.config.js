import { defineConfig } from 'vitest/config';

// Configuración para Stryker: solo los tests del motor y corridas cortas de propiedades y simulaciones
// (cada mutante vuelve a correr los tests que lo cubren).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/game/**/__tests__/**/*.test.js'],
    testTimeout: 120000,
    env: { PROPS_RUNS: '200', SIM_MATCHES: '20' }
  }
});
