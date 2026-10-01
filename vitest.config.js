import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.js'],
    testTimeout: 30000,
    hookTimeout: 60000,
    // Los tests de integración comparten la misma base: correr archivos en serie
    fileParallelism: false
  }
});
