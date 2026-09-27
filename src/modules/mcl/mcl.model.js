import mongoose from 'mongoose';

const { Schema } = mongoose;

/** An MR's personal call list ("My MCL"): doctors picked from the Master MCL. */
const mclEntrySchema = new Schema(
  {
    mr: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    doctor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
mclEntrySchema.index({ mr: 1, doctor: 1 }, { unique: true });
mclEntrySchema.index({ mr: 1, createdAt: -1 });

export const McLEntry = mongoose.model('McLEntry', mclEntrySchema);

/** Upper bound on one MR's list — keeps the list screen and payloads sane. */
export const MCL_LIMIT = 500;
