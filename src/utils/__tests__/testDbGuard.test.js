import { describe, expect, it } from 'vitest';
import { assertSafeTestDb, databaseName } from '../testDbGuard.js';

const atlas = (db) => `mongodb+srv://u:p@cluster0.example.mongodb.net/${db}?retryWrites=true&w=majority`;

describe('guarda de la base de tests', () => {
  it('lee el nombre de la base de la URL', () => {
    expect(databaseName(atlas('truco_test'))).toBe('truco_test');
    expect(databaseName('mongodb://localhost:27017/truco_db?replicaSet=rs0')).toBe('truco_db');
    expect(databaseName('mongodb://localhost:27017')).toBe('');
  });

  it('acepta una base aparte terminada en _test', () => {
    expect(() => assertSafeTestDb(atlas('truco_test'), atlas('truco_db'))).not.toThrow();
  });

  it('rechaza una base que no termina en _test', () => {
    expect(() => assertSafeTestDb(atlas('truco_db'), atlas('otra_db'))).toThrow(/_test/);
    expect(() => assertSafeTestDb(atlas('truco_testing'), '')).toThrow(/_test/);
    expect(() => assertSafeTestDb('mongodb://localhost:27017', '')).toThrow(/_test/);
  });

  it('rechaza la misma base que MONGO_URL', () => {
    expect(() => assertSafeTestDb(atlas('app_test'), atlas('app_test'))).toThrow(/misma base/);
  });
});
