import mongoose from 'mongoose';

export const LEDGER_TYPES = [
  'DAILY_GRANT', 'BET_LOCK', 'BET_PAYOUT', 'BET_REFUND', 'ADMIN_ADJUST',
  'TOURNAMENT_ENTRY', 'TOURNAMENT_PRIZE', 'TOURNAMENT_REFUND'
];

const integer = { validator: Number.isInteger, message: '{PATH} debe ser un entero' };

// Libro contable inmutable: cada movimiento de fichas es un asiento.
// User.balance es una proyección; el ledger es la fuente de verdad auditable.
const LedgerEntrySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: LEDGER_TYPES, required: true, index: true },
  amount: { type: Number, required: true, validate: integer }, // con signo
  balanceAfter: { type: Number, required: true, min: 0, validate: integer },
  refType: { type: String, default: null },
  refId: { type: mongoose.Schema.Types.ObjectId, default: null },
  idempotencyKey: { type: String, required: true, unique: true },
  note: { type: String, default: null, maxlength: 200 }
}, { timestamps: true });

LedgerEntrySchema.index({ userId: 1, createdAt: -1 });

async function rejectMutation() {
  throw new Error('LedgerEntry es inmutable: no se puede modificar ni borrar un asiento');
}

LedgerEntrySchema.pre('save', async function rejectResave() {
  if (!this.isNew) await rejectMutation();
});

for (const op of [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne',
  'deleteOne', 'deleteMany', 'findOneAndDelete'
]) {
  LedgerEntrySchema.pre(op, { document: true, query: true }, rejectMutation);
}

export const LedgerEntry = mongoose.model('LedgerEntry', LedgerEntrySchema);
