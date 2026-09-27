import mongoose from 'mongoose';

const { Schema } = mongoose;

export const PLAN_PERIODS = Object.freeze(['monthly', 'yearly', 'lifetime']);
export const PAYMENT_METHODS = Object.freeze(['card', 'gpay', 'phonepe', 'paytm', 'amazonpay', 'upi']);
export const ORDER_STATUS = Object.freeze(['created', 'paid', 'failed', 'expired']);
export const SUBSCRIPTION_STATUS = Object.freeze(['active', 'cancelled']);

/** A purchasable plan. Prices are in paise and include GST. */
const planSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, trim: true, lowercase: true },
    role: { type: String, enum: ['doctor', 'mr', 'receptionist'], required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    period: { type: String, enum: PLAN_PERIODS, required: true },
    pricePaise: { type: Number, required: true, min: 0 },
    /** Struck-through "original" price shown on the plan card. */
    mrpPaise: { type: Number, min: 0 },
    taxPercent: { type: Number, default: 18, min: 0, max: 50 },
    features: [{ type: String, trim: true, maxlength: 120 }],
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
  },
  { timestamps: true },
);
planSchema.index({ role: 1, active: 1, sort: 1 });

/** A checkout attempt. Amounts are fixed server-side when the order is created. */
const paymentOrderSchema = new Schema(
  {
    number: { type: String, required: true, unique: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    plan: { type: Schema.Types.ObjectId, ref: 'Plan', required: true },
    amountPaise: { type: Number, required: true, min: 0 },
    basePaise: { type: Number, required: true, min: 0 },
    taxPaise: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR' },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    provider: { type: String, required: true },
    providerOrderId: String,
    providerPaymentId: String,
    status: { type: String, enum: ORDER_STATUS, default: 'created' },
    failureReason: String,
    paidAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
paymentOrderSchema.index({ user: 1, createdAt: -1 });
paymentOrderSchema.index({ status: 1, createdAt: -1 });

/** Access period granted by a paid order (or a free plan). */
const subscriptionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    plan: { type: Schema.Types.ObjectId, ref: 'Plan', required: true },
    /** Plan as bought — later price/name edits must not rewrite history. */
    planSnapshot: {
      code: String,
      name: String,
      period: String,
      pricePaise: Number,
    },
    order: { type: Schema.Types.ObjectId, ref: 'PaymentOrder' },
    status: { type: String, enum: SUBSCRIPTION_STATUS, default: 'active' },
    startsAt: { type: Date, required: true },
    /** null = never expires (lifetime). */
    endsAt: Date,
  },
  { timestamps: true },
);
subscriptionSchema.index({ user: 1, status: 1, endsAt: -1 });
// One subscription per paid order, even if confirmation races.
subscriptionSchema.index({ order: 1 }, { unique: true, partialFilterExpression: { order: { $type: 'objectId' } } });

export const Plan = mongoose.model('Plan', planSchema);
export const PaymentOrder = mongoose.model('PaymentOrder', paymentOrderSchema);
export const Subscription = mongoose.model('Subscription', subscriptionSchema);
