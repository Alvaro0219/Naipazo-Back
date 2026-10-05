import mongoose from 'mongoose';
import { connectDb } from '../../config/db.js';
import { env } from '../../config/env.js';
import { LedgerEntry } from '../../models/LedgerEntry.js';
import { Match } from '../../models/Match.js';
import { MatchHandLog } from '../../models/MatchHandLog.js';
import { Room } from '../../models/Room.js';
import { Tournament } from '../../models/Tournament.js';
import { User } from '../../models/User.js';
import { AuthToken } from '../../models/AuthToken.js';
import { assertSafeTestDb } from '../../utils/testDbGuard.js';

// Los tests de integración necesitan un MongoDB con replica set (transacciones).
// Se activan definiendo MONGO_URL_TEST; esa base se BORRA en cada test.
export const hasTestDb = Boolean(env.mongoUrlTest);

export async function connectTestDb() {
  assertSafeTestDb(env.mongoUrlTest, env.mongoUrl); // nunca borrar una base real
  await connectDb(env.mongoUrlTest);
}

export async function resetTestDb() {
  await mongoose.connection.db.dropDatabase();
  // Los índices únicos tienen que existir antes de los tests de concurrencia
  await Promise.all([User, LedgerEntry, Room, Match, MatchHandLog, Tournament, AuthToken].map((model) => model.syncIndexes()));
}

export async function disconnectTestDb() {
  await mongoose.disconnect();
}
