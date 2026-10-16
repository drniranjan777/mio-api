import mongoose from 'mongoose';

const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false });

export const Counter = mongoose.model('Counter', counterSchema);

const PREFIX = { doctor: 'DR', mr: 'MR', receptionist: 'RC', ticket: 'HD', order: 'ORD' };

/** People codes are zero-padded from 1: DR00001, MR00001, RC00001. */
const PERSON_ROLES = new Set(['doctor', 'mr', 'receptionist']);
const PERSON_DIGITS = 5;
/** Tickets and orders keep their original numbering: HD10001, ORD10001. */
const LEGACY_START = 10000;

export function formatCode(role, seq) {
  return PERSON_ROLES.has(role)
    ? `${PREFIX[role]}${String(seq).padStart(PERSON_DIGITS, '0')}`
    : `${PREFIX[role]}${LEGACY_START + seq}`;
}

/** Atomic, human-readable codes: DR00001, MR00001, RC00001, HD10001 (tickets), ORD10001. */
export async function nextCode(role) {
  const c = await Counter.findOneAndUpdate({ _id: role }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return formatCode(role, c.seq);
}
