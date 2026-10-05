import mongoose from 'mongoose';

export const AUTH_TOKEN_TYPES = ['verify-email', 'reset-password'];

// Tokens de un solo uso que viajan por email. Solo se guarda el hash SHA-256: quien lea la base
// no puede usarlos. Mongo borra los vencidos solo (índice TTL), pero la validez se chequea igual.
const AuthTokenSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: AUTH_TOKEN_TYPES, required: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null }
}, { timestamps: true });

AuthTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthToken = mongoose.model('AuthToken', AuthTokenSchema);
