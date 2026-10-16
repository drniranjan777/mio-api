import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI ??= 'mongodb://placeholder';
process.env.JWT_ACCESS_SECRET ??= 'x'.repeat(48);
process.env.OTP_PEPPER ??= 'y'.repeat(24);

const { buildSlots, countFutureSlots, localMidnight } = await import('../src/modules/appointments/schedule.js');

describe('countFutureSlots matches buildSlots', () => {
  const profiles = [
    { mrCall: { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], from: '00:00', to: '23:55', slotMinutes: 15 } },
    { mrCall: { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], from: '10:00', to: '16:00', slotMinutes: 15 } },
    { mrCall: { days: ['Mon'], from: '09:05', to: '09:20', slotMinutes: 15 } },
    { mrCall: { days: ['Sun'], from: '10:00', to: '10:10', slotMinutes: 15 } },
    {},
  ];
  const dates = ['2026-10-12', '2026-10-13', '2026-10-18'];

  it('for every minute of the day, before and after it', () => {
    for (const p of profiles) {
      for (const date of dates) {
        const midnight = localMidnight(date).getTime();
        for (let m = -30; m <= 24 * 60 + 30; m += 1) {
          for (const extraSec of [0, 30]) {
            const now = new Date(midnight + m * 60_000 + extraSec * 1000);
            const expected = buildSlots(p, date).filter((s) => s.startAt.getTime() > now.getTime()).length;
            assert.equal(countFutureSlots(p, date, now), expected, `${JSON.stringify(p)} ${date} +${m}m${extraSec}s`);
          }
        }
      }
    }
  });
});
