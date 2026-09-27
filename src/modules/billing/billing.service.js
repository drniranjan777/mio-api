import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { audit } from '../audit/audit.js';
import { notify } from '../notifications/notifications.service.js';
import { nextCode } from '../users/counter.model.js';
import { PaymentOrder, Plan, Subscription } from './billing.models.js';
import { paymentProvider } from './payment.provider.js';

const DAY_MS = 86_400_000;

/** GST-inclusive price → base + tax (tax rounded to the paise). */
export function splitTax(pricePaise, taxPercent) {
  const basePaise = Math.round((pricePaise * 100) / (100 + taxPercent));
  return { basePaise, taxPaise: pricePaise - basePaise };
}

const presentPlan = (p) => ({
  id: p._id.toString(),
  code: p.code,
  role: p.role,
  name: p.name,
  period: p.period,
  pricePaise: p.pricePaise,
  mrpPaise: p.mrpPaise ?? null,
  taxPercent: p.taxPercent,
  ...splitTax(p.pricePaise, p.taxPercent),
  features: p.features,
});

const presentSubscription = (s) =>
  s && {
    id: s._id.toString(),
    plan: s.planSnapshot,
    status: s.status,
    startsAt: s.startsAt,
    endsAt: s.endsAt ?? null,
    lifetime: !s.endsAt,
  };

const presentOrder = (o) => ({
  id: o._id.toString(),
  number: o.number,
  status: o.status,
  method: o.method,
  provider: o.provider,
  providerOrderId: o.providerOrderId,
  amountPaise: o.amountPaise,
  basePaise: o.basePaise,
  taxPaise: o.taxPaise,
  currency: o.currency,
  failureReason: o.failureReason,
  paidAt: o.paidAt,
  expiresAt: o.expiresAt,
  createdAt: o.createdAt,
});

export async function listPlans(user) {
  const role = user.role === 'admin' ? undefined : user.role;
  const plans = await Plan.find({ active: true, ...(role && { role }) }).sort({ role: 1, sort: 1 }).lean();
  return plans.map(presentPlan);
}

/** The user's subscription that is valid right now (latest end date wins). */
export async function currentSubscription(userId, now = new Date()) {
  return Subscription.findOne({
    user: userId,
    status: 'active',
    startsAt: { $lte: now },
    $or: [{ endsAt: null }, { endsAt: { $gt: now } }],
  })
    .sort({ endsAt: -1 })
    .lean();
}

export async function mySubscription(user) {
  const [current, orders] = await Promise.all([
    currentSubscription(user._id),
    PaymentOrder.find({ user: user._id }).sort({ createdAt: -1 }).limit(10).lean(),
  ]);
  return { current: presentSubscription(current) ?? null, orders: orders.map(presentOrder) };
}

async function loadPlanFor(user, planCode) {
  const plan = await Plan.findOne({ code: planCode, active: true }).lean();
  if (!plan) throw ApiError.notFound('Plan not found', 'PLAN_NOT_FOUND');
  if (plan.role !== user.role) throw ApiError.forbidden('This plan is not available for your account', 'PLAN_FORBIDDEN');
  return plan;
}

/** Monthly/yearly add to any remaining time; lifetime never ends. */
async function grant(user, plan, order, req) {
  const now = new Date();
  const current = await currentSubscription(user._id, now);
  if (current && !current.endsAt) return current; // already lifetime
  let endsAt = null;
  if (plan.period !== 'lifetime') {
    const from = current?.endsAt && current.endsAt > now ? current.endsAt : now;
    const days = plan.period === 'yearly' ? 365 : 30;
    endsAt = new Date(from.getTime() + days * DAY_MS);
  }
  let sub;
  try {
    sub = await Subscription.create({
      user: user._id,
      plan: plan._id,
      planSnapshot: { code: plan.code, name: plan.name, period: plan.period, pricePaise: plan.pricePaise },
      order: order?._id,
      startsAt: now,
      endsAt,
    });
  } catch (err) {
    // A concurrent confirm of the same order already created it.
    if (err?.code === 11000 && order) return Subscription.findOne({ order: order._id }).lean();
    throw err;
  }
  await audit({
    actor: user,
    action: 'subscription.activated',
    module: 'billing',
    entityType: 'Subscription',
    entityId: sub._id,
    after: { plan: plan.code, endsAt, order: order?.number },
    req,
  });
  await notify([user._id], {
    type: 'subscription.activated',
    title: 'Subscription Active',
    body: endsAt ? `${plan.name} plan active till ${endsAt.toISOString().slice(0, 10)}` : `${plan.name} — lifetime access`,
  });
  return sub.toObject();
}

function assertPaymentsEnabled() {
  if (!env.PAYMENTS_ENABLED) {
    throw new ApiError(503, 'PAYMENTS_UNAVAILABLE', 'Online payments are not available yet. Please try again later.');
  }
}

export async function checkout(user, { planCode, method }, req) {
  assertPaymentsEnabled();
  const plan = await loadPlanFor(user, planCode);
  if (plan.pricePaise === 0) {
    throw ApiError.unprocessable('This plan is free — claim it instead of paying', 'PLAN_IS_FREE');
  }
  const current = await currentSubscription(user._id);
  if (current && !current.endsAt) throw ApiError.conflict('You already have lifetime access', 'ALREADY_LIFETIME');

  const { basePaise, taxPaise } = splitTax(plan.pricePaise, plan.taxPercent);
  const number = await nextCode('order');
  const provider = paymentProvider();
  const { providerOrderId } = await provider.createOrder({ number, amountPaise: plan.pricePaise, currency: 'INR' });
  const order = await PaymentOrder.create({
    number,
    user: user._id,
    plan: plan._id,
    amountPaise: plan.pricePaise,
    basePaise,
    taxPaise,
    method,
    provider: provider.name,
    providerOrderId,
    expiresAt: new Date(Date.now() + env.PAYMENT_ORDER_TTL_MINUTES * 60_000),
  });
  await audit({
    actor: user,
    action: 'payment.order_created',
    module: 'billing',
    entityType: 'PaymentOrder',
    entityId: order._id,
    after: { number, plan: plan.code, amountPaise: plan.pricePaise, method },
    req,
  });
  return { order: presentOrder(order), plan: presentPlan(plan) };
}

/**
 * Confirms an order with the provider's payload. Idempotent: a paid order
 * returns its subscription; only a `created` order can move to paid/failed,
 * and that move is a single atomic update so double taps cannot pay twice.
 */
export async function confirm(user, orderId, payload, req) {
  assertPaymentsEnabled();
  const order = await PaymentOrder.findOne({ _id: orderId, user: user._id });
  if (!order) throw ApiError.notFound('Order not found', 'ORDER_NOT_FOUND');
  if (order.status === 'paid') {
    const sub = await Subscription.findOne({ order: order._id }).lean();
    return { order: presentOrder(order), subscription: presentSubscription(sub) };
  }
  if (order.status !== 'created') {
    throw ApiError.unprocessable(`This order is ${order.status}. Please start a new payment.`, 'ORDER_CLOSED');
  }
  if (order.expiresAt <= new Date()) {
    await PaymentOrder.updateOne({ _id: order._id, status: 'created' }, { $set: { status: 'expired' } });
    throw ApiError.unprocessable('This payment session expired. Please start again.', 'ORDER_EXPIRED');
  }

  const result = await paymentProvider().verifyPayment({ order, payload });
  const update = result.ok
    ? { status: 'paid', providerPaymentId: result.providerPaymentId, paidAt: new Date() }
    : { status: 'failed', failureReason: result.reason };
  const updated = await PaymentOrder.findOneAndUpdate({ _id: order._id, status: 'created' }, { $set: update }, { new: true });
  if (!updated) return confirm(user, orderId, payload, req); // lost a race: re-read the settled order

  await audit({
    actor: user,
    action: result.ok ? 'payment.paid' : 'payment.failed',
    module: 'billing',
    entityType: 'PaymentOrder',
    entityId: order._id,
    after: { number: order.number, amountPaise: order.amountPaise, reason: result.reason },
    req,
  });
  if (!result.ok) throw ApiError.unprocessable(result.reason, 'PAYMENT_FAILED');

  const plan = await Plan.findById(order.plan).lean();
  const sub = await grant(user, plan, updated, req);
  return { order: presentOrder(updated), subscription: presentSubscription(sub) };
}

/** Doctor "Claim lifetime Free Access". */
export async function claimFree(user, { planCode }, req) {
  const plan = await loadPlanFor(user, planCode);
  if (plan.pricePaise !== 0) throw ApiError.unprocessable('This plan is not free', 'PLAN_NOT_FREE');
  const current = await currentSubscription(user._id);
  if (current && (!current.endsAt || current.plan.equals(plan._id))) {
    return { subscription: presentSubscription(current) };
  }
  return { subscription: presentSubscription(await grant(user, plan, null, req)) };
}

// ---- Admin -------------------------------------------------------------------

export async function upsertPlan(admin, body, req) {
  const before = await Plan.findOne({ code: body.code }).lean();
  const plan = await Plan.findOneAndUpdate({ code: body.code }, { $set: body }, { upsert: true, new: true, runValidators: true });
  await audit({
    actor: admin,
    action: before ? 'plan.updated' : 'plan.created',
    module: 'billing',
    entityType: 'Plan',
    entityId: plan._id,
    before: before && { pricePaise: before.pricePaise, active: before.active },
    after: { pricePaise: plan.pricePaise, active: plan.active },
    req,
  });
  return presentPlan(plan);
}
