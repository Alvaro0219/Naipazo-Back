// Pruebas de mutación del motor (EXACTITUD_DEL_JUEGO.md, 9.1): meta ≥ 90 % de mutantes detectados.
//   npm run test:mutation   (tarda varios minutos; reporte HTML en reports/mutation/)
export default {
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.stryker.config.js' },
  mutate: [
    'src/game/truco/*.js',
    '!src/game/truco/index.js',
    '!src/game/truco/rules.js',
    '!src/game/truco/errors.js'
  ],
  coverageAnalysis: 'perTest',
  thresholds: { high: 95, low: 90, break: 90 },
  reporters: ['clear-text', 'progress', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always'
};
