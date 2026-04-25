/**
 * Order Validation Service
 *
 * This service handles order validation logic including:
 * - Order cutoff time validation
 * - Delivery date calculation
 * - Credit limit validation
 */

import { prisma } from '@joho-erp/database';

// ============================================================================
// TYPES
// ============================================================================

export interface CutoffValidationResult {
  isAfterCutoff: boolean;
  cutoffTime: string; // Format: "HH:mm"
  cutoffDateTime: Date; // Actual cutoff datetime for the requested delivery date
  nextAvailableDeliveryDate: Date;
  message?: string;
}

export interface CutoffInfo {
  cutoffTime: string; // Format: "HH:mm" (e.g., "14:00")
  isAfterCutoff: boolean;
  currentTime: string; // Format: "HH:mm"
  nextAvailableDeliveryDate: Date;
  workingDays: number[]; // 0=Sun ... 6=Sat
  timezone: string;
}

interface CutoffByArea {
  [areaName: string]: string; // areaName -> "HH:mm" format
}

// Default working days: Monday through Saturday (skip Sunday)
const DEFAULT_WORKING_DAYS: number[] = [1, 2, 3, 4, 5, 6];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parse time string in "HH:mm" format to hours and minutes
 */
function parseTime(timeString: string): { hours: number; minutes: number } {
  const [hours, minutes] = timeString.split(':').map(Number);
  return { hours: hours ?? 0, minutes: minutes ?? 0 };
}

/**
 * Get current time in Australia/Sydney timezone
 */
function getCurrentTimeInSydney(): Date {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Australia/Sydney' })
  );
}

/**
 * Format time as "HH:mm" string
 */
function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-AU', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Australia/Sydney',
  });
}

/**
 * Get today's date at Sydney midnight (no time component)
 */
function getTodaySydneyMidnight(): Date {
  const now = getCurrentTimeInSydney();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return today;
}

/**
 * Check if a given date is a working day based on configured working days
 * @param date - The date to check
 * @param workingDays - Array of weekday numbers (0=Sun, 6=Sat) considered working days
 */
function isWorkingDay(date: Date, workingDays: number[]): boolean {
  return workingDays.includes(date.getDay());
}

/**
 * Add N working days to a start date.
 * The start date itself is NOT counted; counting begins from the next day.
 * Non-working days are skipped (do not increment the counter).
 *
 * @param startDate - The reference date (will not be returned even if it is a working day)
 * @param n - Number of working days to add (must be >= 1)
 * @param workingDays - Array of weekday numbers considered working days
 */
function addWorkingDays(
  startDate: Date,
  n: number,
  workingDays: number[]
): Date {
  if (workingDays.length === 0) {
    throw new Error('workingDays must contain at least one day');
  }

  const result = new Date(startDate);
  result.setHours(0, 0, 0, 0);

  let counted = 0;
  // Loop with a generous safety bound (n * 7 covers any week pattern)
  const maxIterations = Math.max(n * 7, 30);
  for (let i = 0; i < maxIterations; i++) {
    result.setDate(result.getDate() + 1);
    if (isWorkingDay(result, workingDays)) {
      counted++;
      if (counted === n) {
        return result;
      }
    }
  }

  // Should never happen if workingDays is non-empty
  throw new Error('Failed to find n working days within iteration bound');
}

/**
 * Roll a date forward to the next working day if it falls on a non-working day.
 * Used as a safety net for user-supplied dates.
 */
function rollForwardToWorkingDay(date: Date, workingDays: number[]): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);

  // Safety bound: if all 7 days are non-working we have a config error,
  // but bound the loop so we never spin forever.
  for (let i = 0; i < 7; i++) {
    if (isWorkingDay(result, workingDays)) {
      return result;
    }
    result.setDate(result.getDate() + 1);
  }
  return result;
}

/**
 * Format a list of weekday numbers as a human-readable string.
 * E.g. [0] -> "Sunday", [0, 6] -> "Saturday and Sunday".
 */
function formatNonWorkingDays(workingDays: number[]): string {
  const dayNames = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  const nonWorking: string[] = [];
  for (let d = 0; d < 7; d++) {
    if (!workingDays.includes(d)) {
      nonWorking.push(dayNames[d]!);
    }
  }
  if (nonWorking.length === 0) {
    return 'no days';
  }
  if (nonWorking.length === 1) {
    return nonWorking[0]!;
  }
  if (nonWorking.length === 2) {
    return `${nonWorking[0]} and ${nonWorking[1]}`;
  }
  return `${nonWorking.slice(0, -1).join(', ')}, and ${nonWorking[nonWorking.length - 1]}`;
}

// ============================================================================
// MAIN FUNCTIONS
// ============================================================================

/**
 * Get company's order cutoff time settings
 */
export async function getCompanyCutoffSettings(): Promise<{
  orderCutoffTime: string;
  cutoffByArea: CutoffByArea | null;
  workingDays: number[];
  timezone: string;
}> {
  const company = await prisma.company.findFirst({
    select: {
      deliverySettings: true,
    },
  });

  const defaultCutoff = '14:00';
  const timezone = 'Australia/Sydney';

  if (!company?.deliverySettings) {
    return {
      orderCutoffTime: defaultCutoff,
      cutoffByArea: null,
      workingDays: DEFAULT_WORKING_DAYS,
      timezone,
    };
  }

  const configuredWorkingDays = (
    company.deliverySettings as { workingDays?: number[] }
  ).workingDays;

  const workingDays =
    Array.isArray(configuredWorkingDays) && configuredWorkingDays.length > 0
      ? configuredWorkingDays
      : DEFAULT_WORKING_DAYS;

  return {
    orderCutoffTime: company.deliverySettings.orderCutoffTime ?? defaultCutoff,
    cutoffByArea: company.deliverySettings.cutoffByArea as CutoffByArea | null,
    workingDays,
    timezone,
  };
}

/**
 * Get the cutoff time for a specific area (or default if not area-specific)
 */
export async function getCutoffTimeForArea(
  areaName?: string
): Promise<string> {
  const { orderCutoffTime, cutoffByArea } = await getCompanyCutoffSettings();

  // Check for area-specific cutoff time
  if (areaName && cutoffByArea && cutoffByArea[areaName]) {
    return cutoffByArea[areaName];
  }

  return orderCutoffTime;
}

/**
 * Validate if an order can be placed for the requested delivery date.
 * Two checks: (1) requested date is a working day, (2) requested date is at
 * or after the minimum delivery date (which is computed from cutoff + working-day offset).
 *
 * @param requestedDeliveryDate - The date customer wants the order delivered
 * @param areaName - Optional area name for area-specific cutoff times
 */
export async function validateOrderCutoffTime(
  requestedDeliveryDate: Date,
  areaName?: string
): Promise<CutoffValidationResult> {
  const { workingDays } = await getCompanyCutoffSettings();
  const cutoffTime = await getCutoffTimeForArea(areaName);

  // Check #1: requested date must be a working day
  if (!isWorkingDay(requestedDeliveryDate, workingDays)) {
    const nextAvailableDeliveryDate = await getMinDeliveryDate(areaName);
    return {
      isAfterCutoff: true,
      cutoffTime,
      cutoffDateTime: requestedDeliveryDate,
      nextAvailableDeliveryDate,
      message: `${formatNonWorkingDays(workingDays)} deliveries are not available. Please select a working day.`,
    };
  }

  // Check #2: requested date must be at or after the minimum delivery date.
  // The new rule expresses cutoff as a working-day offset (2 before, 3 after) — comparing
  // against minDate is equivalent to and simpler than the old day-before-delivery cutoff hack.
  const minDate = await getMinDeliveryDate(areaName);
  const requestedDateOnly = new Date(requestedDeliveryDate);
  requestedDateOnly.setHours(0, 0, 0, 0);

  const minDateOnly = new Date(minDate);
  minDateOnly.setHours(0, 0, 0, 0);

  const isAfterCutoff = requestedDateOnly < minDateOnly;

  let message: string | undefined;
  if (isAfterCutoff) {
    message = `Order cutoff time (${cutoffTime}) has passed for the requested delivery date. Your order will be delivered on ${minDate.toLocaleDateString('en-AU')}.`;
  }

  return {
    isAfterCutoff,
    cutoffTime,
    cutoffDateTime: minDate,
    nextAvailableDeliveryDate: minDate,
    message,
  };
}

/**
 * Get current cutoff information for display in the UI.
 * Used by customers to see if they're before/after cutoff and what the
 * earliest available delivery date is.
 */
export async function getCutoffInfo(areaName?: string): Promise<CutoffInfo> {
  const { workingDays } = await getCompanyCutoffSettings();
  const now = getCurrentTimeInSydney();
  const cutoffTime = await getCutoffTimeForArea(areaName);
  const { hours: cutoffHours, minutes: cutoffMinutes } = parseTime(cutoffTime);

  // Cutoff datetime for today (Sydney wall clock)
  const todayCutoff = new Date(now);
  todayCutoff.setHours(cutoffHours, cutoffMinutes, 0, 0);

  const isAfterCutoff = now > todayCutoff;

  // Working-day offset: 2 if before cutoff, 3 if after.
  // The order day itself is not counted.
  const today = getTodaySydneyMidnight();
  const offset = isAfterCutoff ? 3 : 2;
  const nextAvailableDeliveryDate = addWorkingDays(today, offset, workingDays);

  return {
    cutoffTime,
    isAfterCutoff,
    currentTime: formatTime(now),
    nextAvailableDeliveryDate,
    workingDays,
    timezone: 'Australia/Sydney',
  };
}

/**
 * Get the minimum allowed delivery date for a new order.
 */
export async function getMinDeliveryDate(areaName?: string): Promise<Date> {
  const { nextAvailableDeliveryDate } = await getCutoffInfo(areaName);
  return nextAvailableDeliveryDate;
}

/**
 * Check if a specific delivery date is valid.
 * A date is valid if it's a working day and at or after the minimum delivery date.
 */
export async function isValidDeliveryDate(
  requestedDate: Date,
  areaName?: string
): Promise<boolean> {
  const { workingDays } = await getCompanyCutoffSettings();

  if (!isWorkingDay(requestedDate, workingDays)) {
    return false;
  }

  const minDate = await getMinDeliveryDate(areaName);

  const requestedDateOnly = new Date(requestedDate);
  requestedDateOnly.setHours(0, 0, 0, 0);

  const minDateOnly = new Date(minDate);
  minDateOnly.setHours(0, 0, 0, 0);

  return requestedDateOnly >= minDateOnly;
}

// Re-export helpers used by other modules / tests
export { isWorkingDay, addWorkingDays, rollForwardToWorkingDay };
