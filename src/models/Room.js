import mongoose from 'mongoose';

export const ROOM_STATUSES = ['waiting', 'playing', 'finished', 'cancelled'];
export const ACTIVE_ROOM_STATUSES = ['waiting', 'playing'];

const SeatSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true } // el nombre de usuario no se puede cambiar
}, { _id: false });

const RoomSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  hostId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  config: {
    targetPoints: { type: Number, enum: [15, 30], required: true },
    withFlor: { type: Boolean, default: false },
    // Sala privada: no aparece en el lobby, solo se entra con su código
    isPrivate: { type: Boolean, default: false },
    bet: { type: Number, default: 0, min: 0, validate: { validator: Number.isInteger } },
    maxPlayers: { type: Number, default: 2 }
  },
  seats: { type: [SeatSchema], default: [] },
  status: { type: String, enum: ROOM_STATUSES, default: 'waiting', index: true },
  matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', default: null },
  rematchOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null }, // sala de origen de una revancha
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', default: null, index: true }, // sala de torneo: no va al lobby
  uuid: { type: String, required: true, unique: true } // idempotencia de la creación desde el cliente
}, { timestamps: true });

RoomSchema.index({ 'seats.userId': 1, status: 1 });
RoomSchema.index({ status: 1, createdAt: -1 });

export const Room = mongoose.model('Room', RoomSchema);
