import mongoose from 'mongoose';

export const ROOM_STATUSES = ['waiting', 'playing', 'finished', 'cancelled'];
export const ACTIVE_ROOM_STATUSES = ['waiting', 'playing'];

const SeatSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true }, // el nombre de usuario no se puede cambiar
  // M8: asiento 0–3 (equipo = asiento % 2). Las salas viejas no lo tienen: vale el orden del array
  seat: { type: Number, min: 0, max: 3 }
}, { _id: false });

export const ROOM_MODES = ['1v1', '2v2'];

const RoomSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  hostId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  config: {
    targetPoints: { type: Number, enum: [15, 30], required: true },
    withFlor: { type: Boolean, default: false },
    // Sala privada: no aparece en el lobby, solo se entra con su código
    isPrivate: { type: Boolean, default: false },
    bet: { type: Number, default: 0, min: 0, validate: { validator: Number.isInteger } },
    // M8: 1 vs 1 (2 asientos) o 2 vs 2 (4 asientos)
    mode: { type: String, enum: ROOM_MODES, default: '1v1' },
    maxPlayers: { type: Number, enum: [2, 4], default: 2 }
  },
  seats: { type: [SeatSchema], default: [] },
  status: { type: String, enum: ROOM_STATUSES, default: 'waiting', index: true },
  // P6: por qué se canceló (null = la canceló el anfitrión)
  cancelReason: { type: String, enum: ['expired', null], default: null },
  matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', default: null },
  rematchOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null }, // sala de origen de una revancha
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', default: null, index: true }, // sala de torneo: no va al lobby
  uuid: { type: String, required: true, unique: true } // idempotencia de la creación desde el cliente
}, { timestamps: true });

RoomSchema.index({ 'seats.userId': 1, status: 1 });
RoomSchema.index({ status: 1, createdAt: -1 });

export const Room = mongoose.model('Room', RoomSchema);
