import mongoose from 'mongoose';

const MatchPlayerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true },
  seat: { type: Number, required: true },
  team: { type: Number, enum: [0, 1], required: true },
  betLocked: { type: Number, default: 0 }
}, { _id: false });

const MatchSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  // Copia inmutable de la configuración de la sala al momento de empezar
  config: {
    targetPoints: { type: Number, enum: [15, 30], required: true },
    withFlor: { type: Boolean, default: false },
    bet: { type: Number, default: 0 }
  },
  players: { type: [MatchPlayerSchema], required: true },
  status: { type: String, enum: ['playing', 'finished', 'cancelled'], default: 'playing', index: true },
  score: { type: [Number], default: [0, 0] },
  handsPlayed: { type: Number, default: 0 },
  winnerTeam: { type: Number, enum: [0, 1, null], default: null },
  endReason: { type: String, enum: ['normal', 'abandon', 'timeout', 'cancelled', null], default: null },
  startedAt: { type: Date, required: true },
  endedAt: { type: Date, default: null }
}, { timestamps: true });

MatchSchema.index({ 'players.userId': 1, createdAt: -1 });

export const Match = mongoose.model('Match', MatchSchema);
