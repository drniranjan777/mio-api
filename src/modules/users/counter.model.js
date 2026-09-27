import mongoose from 'mongoose';

const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false });

export const Counter = mongoose.model('Counter', counterSchema);

const PREFIX = { doctor: 'DR', mr: 'MR', receptionist: 'RC', ticket: 'HD', order: 'ORD' };
const START = 10000;

/** Atomic, human-readable codes: DR10001, MR10001, RC10001, HD10001 (tickets), ORD10001. */
export async function nextCode(role) {
  const c = await Counter.findOneAndUpdate({ _id: role }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return `${PREFIX[role]}${START + c.seq}`;
}
