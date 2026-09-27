import mongoose from 'mongoose';

const { Schema } = mongoose;

/** A birthday wish from an MR to a doctor, tied to one birthday occurrence. */
const wishSchema = new Schema(
  {
    doctor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    mr: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** "YYYY-MM-DD" of the birthday this wish is for. */
    birthdayOn: { type: String, required: true },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    /** Snapshot for display (the MR's company can change later). */
    company: { type: String, trim: true },
    hiddenAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
wishSchema.index({ doctor: 1, birthdayOn: 1, createdAt: 1 });
wishSchema.index({ mr: 1, doctor: 1, birthdayOn: 1 });
wishSchema.index({ doctor: 1, createdAt: -1 });

export const Wish = mongoose.model('Wish', wishSchema);

export const WISHES_PER_BIRTHDAY = 3;
