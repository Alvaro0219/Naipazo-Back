import mongoose from 'mongoose';

const MatchPlayerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true },
  seat: { type: Number, required: true },
  team: { type: Number, enum: [0, 1], required: true },
  betLocked: { type: Number, default: 0 },
  // M8: resultado de cada jugador (en 2 vs 2, el compañero de quien abandona queda sin resultado)
  result: { type: String, enum: ['win', 'loss', 'abandon', 'no-result', null], default: null }
}, { _id: false });

const MatchSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  // Copia inmutable de la configuración de la sala al momento de empezar
  config: {
    targetPoints: { type: Number, enum: [15, 30], required: true },
    withFlor: { type: Boolean, default: false },
    // P5: las partidas de salas privadas no cuentan para el ranking ni las estadísticas
    isPrivate: { type: Boolean, default: false },
    mode: { type: String, enum: ['1v1', '2v2'], default: '1v1' },
    bet: { type: Number, default: 0 }
  },
  players: { type: [MatchPlayerSchema], required: true },
  status: { type: String, enum: ['playing', 'finished', 'cancelled'], default: 'playing', index: true },
  score: { type: [Number], default: [0, 0] },
  handsPlayed: { type: Number, default: 0 },
  winnerTeam: { type: Number, enum: [0, 1, null], default: null },
  endReason: { type: String, enum: ['normal', 'abandon', 'timeout', 'cancelled', null], default: null },
  abandonedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // M8: todos los que abandonaron (en 2 vs 2 pueden ser los dos de un equipo)
  abandoners: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  // false mientras haya apuestas bloqueadas sin pagar ni devolver (se reintenta al arrancar el server)
  betsSettled: { type: Boolean, default: true, index: true },
  // Partidas de torneo: sin apuesta propia (el pozo lo retiene el torneo)
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', default: null, index: true },
  round: { type: Number, default: null },
  startedAt: { type: Date, required: true },
  endedAt: { type: Date, default: null }
}, { timestamps: true });

MatchSchema.index({ 'players.userId': 1, createdAt: -1 });

export const Match = mongoose.model('Match', MatchSchema);
