import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MINUTE = 60_000;

/** No MR appointments on Sundays, whatever a doctor's saved days say (App Corrections, 18 Oct 2026). */
export const CLOSED_DAY = 'Sun';

/** Used when a doctor has not configured MR call hours yet (PDF: "10:00 AM to 04:00 PM"). */
export const DEFAULT_MR_CALL = Object.freeze({
  days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  from: '10:00',
  to: '16:00',
  slotMinutes: 15,
  maxPerDay: null,
});

const offsetMs = () => env.TZ_OFFSET_MINUTES * MINUTE;
const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export function effectiveMrCall(profile) {
  const c = profile?.mrCall ?? {};
  return {
    days: (c.days?.length ? c.days : DEFAULT_MR_CALL.days).filter((d) => d !== CLOSED_DAY),
    from: c.from ?? DEFAULT_MR_CALL.from,
    to: c.to ?? DEFAULT_MR_CALL.to,
    slotMinutes: c.slotMinutes ?? DEFAULT_MR_CALL.slotMinutes,
    maxPerDay: c.maxPerDay ?? DEFAULT_MR_CALL.maxPerDay,
  };
}

/** UTC instant of local midnight for a "YYYY-MM-DD" date. */
export function localMidnight(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - offsetMs());
}

/** Local calendar info for a UTC instant. */
export function localParts(date) {
  const local = new Date(date.getTime() + offsetMs());
  return {
    dateStr: local.toISOString().slice(0, 10),
    day: DAY_NAMES[local.getUTCDay()],
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
    seconds: local.getUTCSeconds(),
    ms: local.getUTCMilliseconds(),
  };
}

export function formatTime(date) {
  const { minutes } = localParts(date);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Mon, 28 Sep · 10:00 AM" in local time (notification text). */
export function formatWhen(date) {
  const { dateStr, day } = localParts(date);
  const [, m, d] = dateStr.split('-').map(Number);
  return `${day}, ${d} ${MONTHS[m - 1]} · ${formatTime(date)}`;
}

export function dayBounds(dateStr) {
  const start = localMidnight(dateStr);
  return { start, end: new Date(start.getTime() + 24 * 60 * MINUTE) };
}

/** All slots of a day for a doctor (empty when the doctor doesn't take MR calls that day). */
export function buildSlots(profile, dateStr) {
  const call = effectiveMrCall(profile);
  const start = localMidnight(dateStr);
  if (!call.days.includes(localParts(start).day)) return [];
  const slots = [];
  for (let m = toMinutes(call.from); m + call.slotMinutes <= toMinutes(call.to); m += call.slotMinutes) {
    const startAt = new Date(start.getTime() + m * MINUTE);
    slots.push({ startAt, endAt: new Date(startAt.getTime() + call.slotMinutes * MINUTE), label: formatTime(startAt) });
  }
  return slots;
}

/**
 * Number of slots of `dateStr` that start after `now` — same answer as
 * `buildSlots(...).filter(s => s.startAt > now).length`, without building
 * them (directory cards need only the count, for many doctors per request).
 */
export function countFutureSlots(profile, dateStr, now = new Date()) {
  const call = effectiveMrCall(profile);
  const start = localMidnight(dateStr);
  if (!call.days.includes(localParts(start).day)) return 0;
  const from = toMinutes(call.from);
  const lastStart = toMinutes(call.to) - call.slotMinutes;
  if (lastStart < from) return 0;
  const total = Math.floor((lastStart - from) / call.slotMinutes) + 1;
  const elapsed = (now.getTime() - start.getTime()) / MINUTE; // minutes since local midnight
  if (elapsed < from) return total;
  // First slot strictly after now.
  const firstFuture = Math.floor((elapsed - from) / call.slotMinutes) + 1;
  return Math.max(0, total - firstFuture);
}

/** Throws unless `startAt` is a future, grid-aligned slot inside the doctor's MR call window. */
export function assertBookableSlot(profile, startAt, now = new Date()) {
  const call = effectiveMrCall(profile);
  if (startAt.getTime() <= now.getTime()) {
    throw ApiError.unprocessable('Please choose a future time slot', 'SLOT_IN_PAST');
  }
  const { day, minutes, seconds, ms } = localParts(startAt);
  if (day === CLOSED_DAY) {
    throw ApiError.unprocessable('MR appointments cannot be booked on Sundays', 'SUNDAY_CLOSED');
  }
  const from = toMinutes(call.from);
  const to = toMinutes(call.to);
  const aligned = seconds === 0 && ms === 0 && (minutes - from) % call.slotMinutes === 0;
  if (!call.days.includes(day) || minutes < from || minutes + call.slotMinutes > to || !aligned) {
    throw ApiError.unprocessable('The doctor does not take MR appointments at this time', 'SLOT_UNAVAILABLE');
  }
  return new Date(startAt.getTime() + call.slotMinutes * MINUTE);
}
