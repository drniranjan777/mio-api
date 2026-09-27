import mongoose from 'mongoose';

const { Schema } = mongoose;

export const TICKET_STATUS = Object.freeze(['open', 'in_progress', 'resolved', 'closed']);
export const OPEN_TICKET_STATUS = Object.freeze(['open', 'in_progress']);
export const AUDIENCES = Object.freeze(['all', 'doctor', 'mr', 'receptionist']);
export const CONTENT_KEYS = Object.freeze(['terms-of-service', 'terms-of-agreement', 'privacy-policy']);

const replySchema = new Schema(
  {
    by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, required: true },
    message: { type: String, required: true, trim: true, maxlength: 1000 },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

/** Help Desk request raised from an issue category. */
const helpTicketSchema = new Schema(
  {
    number: { type: String, required: true, unique: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, required: true },
    category: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 1000 },
    status: { type: String, enum: TICKET_STATUS, default: 'open' },
    replies: { type: [replySchema], default: [] },
    /** Admin team member handling this request. */
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: Date,
  },
  { timestamps: true },
);
helpTicketSchema.index({ user: 1, createdAt: -1 });
helpTicketSchema.index({ status: 1, createdAt: -1 });
helpTicketSchema.index({ assignedTo: 1, status: 1, createdAt: -1 });

const faqSchema = new Schema(
  {
    audience: { type: String, enum: AUDIENCES, default: 'all' },
    question: { type: String, required: true, trim: true, maxlength: 200 },
    answer: { type: String, required: true, trim: true, maxlength: 2000 },
    sort: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
faqSchema.index({ active: 1, audience: 1, sort: 1 });

/** Versioned legal/content pages (Terms & Policies). */
const contentPageSchema = new Schema(
  {
    key: { type: String, enum: CONTENT_KEYS, required: true, unique: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    effectiveDate: { type: String, required: true }, // "YYYY-MM-DD"
    intro: { type: String, trim: true, maxlength: 2000 },
    sections: [
      {
        _id: false,
        title: { type: String, required: true, trim: true, maxlength: 160 },
        body: { type: String, trim: true, maxlength: 4000 },
        points: [{ type: String, trim: true, maxlength: 600 }],
      },
    ],
    version: { type: Number, default: 1 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

/** Small admin-editable settings (support contacts, help topics). */
const appSettingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: Schema.Types.Mixed,
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const HelpTicket = mongoose.model('HelpTicket', helpTicketSchema);
export const Faq = mongoose.model('Faq', faqSchema);
export const ContentPage = mongoose.model('ContentPage', contentPageSchema);
export const AppSetting = mongoose.model('AppSetting', appSettingSchema);
