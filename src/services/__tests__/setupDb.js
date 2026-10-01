import mongoose from 'mongoose';
import { connectDb } from '../../config/db.js';
import { env } from '../../config/env.js';
import { LedgerEntry } from '../../models/LedgerEntry.js';
import { User } from '../../models/User.js';

// Los tests de integración necesitan un MongoDB con replica set (transacciones).
// Se activan definiendo MONGO_URL_TEST; esa base se BORRA en cada test.
export const hasTestDb = Boolean(env.mongoUrlTest);

export async function connectTestDb() {
  await connectDb(env.mongoUrlTest);
}

export async function resetTestDb() {
  await mongoose.connection.db.dropDatabase();
  // Los índices únicos tienen que existir antes de los tests de concurrencia
  await Promise.all([User.syncIndexes(), LedgerEntry.syncIndexes()]);
}

export async function disconnectTestDb() {
  await mongoose.disconnect();
}
