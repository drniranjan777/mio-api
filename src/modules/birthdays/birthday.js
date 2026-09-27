import { localParts } from '../appointments/schedule.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;

/** How long after the day a birthday still counts as "current" (wishes allowed). */
export const GRACE_DAYS = 7;
/** How far ahead a birthday counts as upcoming (wishes allowed, "This Month"). */
export const AHEAD_DAYS = 30;

/** Parses "DD/MM" or "DD/MM/YYYY" → { day, month, year? } or null. */
export function parseDob(value) {
  const m = /^(\d{2})\/(\d{2})(?:\/(\d{4}))?$/.exec(value ?? '');
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = m[3] ? Number(m[3]) : undefined;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { day, month, year };
}

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const utcDay = (y, m, d) => Date.UTC(y, m - 1, m === 2 && d === 29 && !isLeap(y) ? 28 : d);

/**
 * The birthday occurrence that is "current" relative to today (local time):
 * this year's, unless it passed more than GRACE_DAYS ago, then next year's.
 */
export function occurrence(dob, now = new Date()) {
  const [y, m, d] = localParts(now).dateStr.split('-').map(Number);
  const today = Date.UTC(y, m - 1, d);
  let year = y;
  let at = utcDay(year, dob.month, dob.day);
  if ((at - today) / DAY_MS < -GRACE_DAYS) {
    year += 1;
    at = utcDay(year, dob.month, dob.day);
  }
  const date = new Date(at);
  return {
    date: date.toISOString().slice(0, 10),
    label: `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`,
    daysUntil: Math.round((at - today) / DAY_MS),
    turning: dob.year ? year - dob.year : undefined,
  };
}

export const canWish = (occ) => occ.daysUntil >= -GRACE_DAYS && occ.daysUntil <= AHEAD_DAYS;
