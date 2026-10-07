import mongoose from 'mongoose';

// Incidentes de integridad (EXACTITUD_DEL_JUEGO.md, sección 10): partidas congeladas por un invariante roto,
// auditorías que no coinciden y diferencias de la conciliación de fichas. La meta es CERO.
export const INCIDENT_TYPES = ['invariant', 'audit', 'reconciliation'];

const IncidentSchema = new mongoose.Schema({
  type: { type: String, enum: INCIDENT_TYPES, required: true, index: true },
  matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', default: null, index: true },
  summary: { type: String, required: true },
  // Todo lo necesario para reproducir y corregir: violaciones, estado del motor, registro de la mano, diferencias
  details: { type: mongoose.Schema.Types.Mixed, default: null },
  rulesVersion: { type: Number, default: null },
  resolved: { type: Boolean, default: false, index: true }
}, { timestamps: true });

export const Incident = mongoose.model('Incident', IncidentSchema);
