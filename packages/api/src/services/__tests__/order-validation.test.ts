/**
 * order-validation service tests
 *
 * Verifies working-day-aware delivery date computation and cutoff handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock prisma BEFORE importing the service under test.
const findFirstMock = vi.fn();
vi.mock('@joho-erp/database', () => ({
  prisma: {
    company: {
      findFirst: (...args: unknown[]) => findFirstMock(...args),
    },
  },
}));

import {
  validateOrderCutoffTime,
  getMinDeliveryDate,
  getCutoffInfo,
  isWorkingDay,
  addWorkingDays,
} from '../order-validation';

/**
 * Configure the mocked DB to return a specific working-day set + cutoff.
 */
function setCompanySettings(
  workingDays: number[] | undefined,
  orderCutoffTime = '14:00'
) {
  findFirstMock.mockReset();
  findFirstMock.mockResolvedValue({
    deliverySettings: {
      workingDays,
      orderCutoffTime,
      cutoffByArea: null,
    },
  });
}

/**
 * Force getCurrentTimeInSydney() to return a specific moment.
 *
 * The service uses `new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Sydney' }))`.
 * vi.setSystemTime applies to `Date.now()` / `new Date()`. Using a fixed UTC instant
 * with `setSystemTime` is sufficient for these tests because the comparisons hinge on
 * Sydney wall-clock day-of-week and HH:mm — not on the underlying TZ offset.
 *
 * We pick UTC instants that, when localised to Australia/Sydney, land on the desired
 * day at the desired wall-clock time. Sydney is UTC+10 (no DST) for the dates picked.
 * 2026-04 is outside DST in Sydney (DST ends early April), so AEST (UTC+10) applies.
 */
function setSydneyNow(year: number, month: number, day: number, hour: number, minute: number) {
  // Sydney = UTC+10 in April 2026 (post-DST). Construct a UTC instant whose Sydney
  // wall-clock matches the desired (year, month, day, hour, minute).
  const utcMillis = Date.UTC(year, month - 1, day, hour - 10, minute, 0);
  vi.setSystemTime(new Date(utcMillis));
}

describe('order-validation: helpers', () => {
  it('isWorkingDay respects configured workingDays', () => {
    // Saturday is index 6
    const saturday = new Date(2026, 3, 25); // 2026-04-25 is a Saturday
    expect(isWorkingDay(saturday, [1, 2, 3, 4, 5, 6])).toBe(true);
    expect(isWorkingDay(saturday, [1, 2, 3, 4, 5])).toBe(false);
  });

  it('addWorkingDays does not count the start date and skips non-working days', () => {
    // 2026-04-20 is a Monday
    const monday = new Date(2026, 3, 20);
    monday.setHours(0, 0, 0, 0);

    // Mon-Sat: +2 working days = Wednesday
    const wed = addWorkingDays(monday, 2, [1, 2, 3, 4, 5, 6]);
    expect(wed.getDay()).toBe(3); // Wed
    expect(wed.getDate()).toBe(22);

    // Mon-Fri: +3 working days = Thursday (no skipping needed)
    const thu = addWorkingDays(monday, 3, [1, 2, 3, 4, 5]);
    expect(thu.getDay()).toBe(4);
    expect(thu.getDate()).toBe(23);
  });
});

describe('order-validation: getMinDeliveryDate (cutoff offsets)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Mon 10:00, Mon-Sat → min date is Wed (+2 working days)', async () => {
    setCompanySettings([1, 2, 3, 4, 5, 6], '14:00');
    setSydneyNow(2026, 4, 20, 10, 0); // 2026-04-20 is Mon
    const min = await getMinDeliveryDate();
    expect(min.getDay()).toBe(3); // Wed
    expect(min.getDate()).toBe(22);
  });

  it('Mon 16:00, Mon-Sat → min date is Thu (+3 working days)', async () => {
    setCompanySettings([1, 2, 3, 4, 5, 6], '14:00');
    setSydneyNow(2026, 4, 20, 16, 0); // Mon 4pm
    const min = await getMinDeliveryDate();
    expect(min.getDay()).toBe(4); // Thu
    expect(min.getDate()).toBe(23);
  });

  it('Fri 10:00, Mon-Sat → min date is Mon (Sat counts, Sun skipped)', async () => {
    setCompanySettings([1, 2, 3, 4, 5, 6], '14:00');
    setSydneyNow(2026, 4, 24, 10, 0); // 2026-04-24 is Fri
    const min = await getMinDeliveryDate();
    // Sat = +1, Sun skipped, Mon = +2 -> 2026-04-27 (Mon)
    expect(min.getDay()).toBe(1);
    expect(min.getDate()).toBe(27);
  });

  it('Fri 16:00, Mon-Fri → min date is Wed (Sat & Sun skipped)', async () => {
    setCompanySettings([1, 2, 3, 4, 5], '14:00');
    setSydneyNow(2026, 4, 24, 16, 0); // Fri 4pm
    const min = await getMinDeliveryDate();
    // Mon=+1, Tue=+2, Wed=+3 -> 2026-04-29
    expect(min.getDay()).toBe(3);
    expect(min.getDate()).toBe(29);
  });

  it('Sat 10:00, Mon-Sat → min date is Tue (Sun skipped)', async () => {
    setCompanySettings([1, 2, 3, 4, 5, 6], '14:00');
    setSydneyNow(2026, 4, 25, 10, 0); // 2026-04-25 is Sat
    const min = await getMinDeliveryDate();
    // Mon=+1 (Sun skipped), Tue=+2 -> 2026-04-28
    expect(min.getDay()).toBe(2);
    expect(min.getDate()).toBe(28);
  });

  it('falls back to Mon-Sat default when workingDays is missing', async () => {
    setCompanySettings(undefined, '14:00');
    setSydneyNow(2026, 4, 20, 10, 0); // Mon 10am
    const min = await getMinDeliveryDate();
    expect(min.getDay()).toBe(3); // Wed
  });
});

describe('order-validation: validateOrderCutoffTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a Sunday request when Mon-Sat are configured', async () => {
    setCompanySettings([1, 2, 3, 4, 5, 6], '14:00');
    setSydneyNow(2026, 4, 20, 10, 0); // Mon
    const sunday = new Date(2026, 3, 26); // 2026-04-26 is Sun
    const result = await validateOrderCutoffTime(sunday);
    expect(result.isAfterCutoff).toBe(true);
    expect(result.message).toMatch(/Sunday/);
  });

  it('rejects a request earlier than the min delivery date', async () => {
    setCompanySettings([1, 2, 3, 4, 5, 6], '14:00');
    setSydneyNow(2026, 4, 20, 10, 0); // Mon 10am -> min = Wed 22nd
    const tuesday = new Date(2026, 3, 21); // Tue 21st (working day, but before min)
    const result = await validateOrderCutoffTime(tuesday);
    expect(result.isAfterCutoff).toBe(true);
    expect(result.message).toMatch(/cutoff time/i);
  });

  it('accepts a request at/after the min delivery date', async () => {
    setCompanySettings([1, 2, 3, 4, 5, 6], '14:00');
    setSydneyNow(2026, 4, 20, 10, 0); // Mon 10am -> min = Wed 22nd
    const wed = new Date(2026, 3, 22);
    const result = await validateOrderCutoffTime(wed);
    expect(result.isAfterCutoff).toBe(false);
  });
});

describe('order-validation: getCutoffInfo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes workingDays in the response', async () => {
    setCompanySettings([1, 2, 3, 4, 5], '14:00');
    setSydneyNow(2026, 4, 20, 10, 0);
    const info = await getCutoffInfo();
    expect(info.workingDays).toEqual([1, 2, 3, 4, 5]);
    expect(info.isAfterCutoff).toBe(false);
  });
});
