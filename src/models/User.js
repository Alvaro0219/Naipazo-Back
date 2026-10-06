import mongoose from 'mongoose';
import { USERNAME_MAX, USERNAME_MIN, USERNAME_REGEX } from '../utils/username.js';

const integer = { validator: Number.isInteger, message: '{PATH} debe ser un entero' };

const StatsSchema = new mongoose.Schema({
  played: { type: Number, default: 0, validate: integer },
  won: { type: Number, default: 0, validate: integer },
  lost: { type: Number, default: 0, validate: integer },
  abandoned: { type: Number, default: 0, validate: integer },
  chipsWon: { type: Number, default: 0, validate: integer },
  tournamentsPlayed: { type: Number, default: 0, validate: integer },
  tournamentsWon: { type: Number, default: 0, validate: integer }
}, { _id: false });

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true, unique: true },
  // Se guarda tal como lo escribió el usuario; la unicidad la garantiza usernameLower
  username: {
    type: String,
    required: true,
    trim: true,
    minlength: USERNAME_MIN,
    maxlength: USERNAME_MAX,
    match: USERNAME_REGEX
  },
  usernameLower: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['player', 'admin'], default: 'player', index: true },
  isActive: { type: Boolean, default: true, index: true },
  emailVerified: { type: Boolean, default: false },
  // Solo se modifica mediante walletService (operaciones atómicas + LedgerEntry)
  balance: { type: Number, default: 0, min: 0, validate: integer },
  lastDailyGrantDate: { type: String, default: null }, // YYYY-MM-DD en APP_TIMEZONE
  stats: { type: StatsSchema, default: () => ({}) }, // 1 vs 1 (y torneos)
  // M8: estadísticas del 2 vs 2, aparte (las de 1 vs 1 no cambian)
  statsTwoVsTwo: { type: StatsSchema, default: () => ({}) },
  acceptedTermsAt: { type: Date, required: true },
  // Se incrementa para invalidar todos los refresh tokens emitidos (logout, bloqueo)
  tokenVersion: { type: Number, default: 0 }
}, { timestamps: true });

UserSchema.pre('validate', function setUsernameLower() {
  if (this.username) this.usernameLower = this.username.trim().toLowerCase();
});

export const User = mongoose.model('User', UserSchema);
