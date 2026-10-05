/** Nombre de la base de una URL de MongoDB (lo que va después del host y antes de `?`). */
export function databaseName(url) {
  const match = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(url || '');
  return match ? decodeURIComponent(match[1]) : '';
}

/**
 * Los tests de integración BORRAN la base de MONGO_URL_TEST. Antes de conectar se verifica que sea
 * una base de pruebas: su nombre termina en `_test` y no es la misma que MONGO_URL.
 */
export function assertSafeTestDb(testUrl, mainUrl) {
  const name = databaseName(testUrl);
  if (!name.endsWith('_test')) {
    throw new Error(`MONGO_URL_TEST apunta a la base "${name || '(sin nombre)'}": su nombre tiene que terminar en "_test". Los tests la borran.`);
  }
  if (mainUrl && (testUrl === mainUrl || name === databaseName(mainUrl))) {
    throw new Error('MONGO_URL_TEST apunta a la misma base que MONGO_URL. Los tests la borran: usá una base aparte terminada en "_test".');
  }
}
