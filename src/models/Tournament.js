import mongoose from 'mongoose';

export const TOURNAMENT_STATUSES = ['waiting', 'playing', 'finished', 'cancelled'];
export const TOURNAMENT_SIZES = [4, 8];

const integer = { validator: Number.isInteger, message: '{PATH} debe ser un entero' };

const EntrantSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true },
  // Identificador de esta inscripción: las claves de idempotencia del cobro y la devolución lo usan,
  // así salir y volver a entrar genera movimientos nuevos (no "ya cobrado").
  entryId: { type: mongoose.Schema.Types.ObjectId, required: true },
  paid: { type: Number, default: 0, validate: integer },
  eliminated: { type: Boolean, default: false },
  joinedAt: { type: Date, default: Date.now }
}, { _id: false });

// Una llave del cuadro: dos jugadores (null mientras no se definen), su sala/partida y el ganador.
// El cuadro es una lista plana ordenada por ronda y llave (ver utils/bracket.js).
const BracketMatchSchema = new mongoose.Schema({
  round: { type: Number, required: true },
  slot: { type: Number, required: true },
  players: { type: [mongoose.Schema.Types.ObjectId], default: [null, null] },
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null },
  matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', default: null },
  winnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // pending: faltan jugadores | ready: están los dos, por arrancar | playing | finished
  status: { type: String, enum: ['pending', 'ready', 'playing', 'finished'], default: 'pending' }
}, { _id: false });

const TournamentSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  hostId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  config: {
    size: { type: Number, enum: TOURNAMENT_SIZES, required: true },
    buyIn: { type: Number, default: 0, min: 0, validate: integer },
    targetPoints: { type: Number, enum: [15, 30], required: true }
  },
  entrants: { type: [EntrantSchema], default: [] },
  status: { type: String, enum: TOURNAMENT_STATUSES, default: 'waiting', index: true },
  bracket: { type: [BracketMatchSchema], default: [] },
  winnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  prize: { type: Number, default: 0, validate: integer },
  // false mientras haya premio o devoluciones pendientes (se reintenta al arrancar el server)
  settled: { type: Boolean, default: true, index: true },
  uuid: { type: String, required: true, unique: true }, // idempotencia de la creación desde el cliente
  startedAt: { type: Date, default: null },
  endedAt: { type: Date, default: null }
}, { timestamps: true });

TournamentSchema.index({ 'entrants.userId': 1, status: 1 });
TournamentSchema.index({ status: 1, createdAt: -1 });

export const Tournament = mongoose.model('Tournament', TournamentSchema);
