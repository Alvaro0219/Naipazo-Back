import mongoose from 'mongoose';

// Registro auditable de cada mano: mazo barajado, cartas repartidas y acciones en orden.
// Contiene cartas ocultas: NUNCA se expone a los clientes antes de que la partida termine.
const HandEventSchema = new mongoose.Schema({
  action: { type: String, required: true },
  playerId: { type: String, required: true },
  payload: { type: mongoose.Schema.Types.Mixed, default: null },
  timestamp: { type: Date, required: true }
}, { _id: false });

const MatchHandLogSchema = new mongoose.Schema({
  matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', required: true },
  handNumber: { type: Number, required: true },
  manoId: { type: String, required: true },
  deck: { type: [String], required: true },
  dealt: { type: mongoose.Schema.Types.Mixed, required: true }, // { userId: [cartas] }
  events: { type: [HandEventSchema], default: [] },
  // Eventos del motor que ya se emitieron a ambos jugadores (cartas jugadas, cantos, tantos cantados).
  // Son los únicos que se muestran en el detalle de la partida.
  publicEvents: { type: [mongoose.Schema.Types.Mixed], default: [] },
  result: { type: mongoose.Schema.Types.Mixed, default: null }, // { winnerTeam, points, reason } o null si la partida terminó a mitad de mano
  scoreAfter: { type: [Number], default: [0, 0] },
  startedAt: { type: Date, required: true },
  endedAt: { type: Date, default: null }
}, { timestamps: true });

MatchHandLogSchema.index({ matchId: 1, handNumber: 1 }, { unique: true });

export const MatchHandLog = mongoose.model('MatchHandLog', MatchHandLogSchema);
