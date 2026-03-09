import { CronExpressionParser } from "cron-parser";

/**
 * Compute the next run time from a cron schedule string.
 * Uses cron-parser for robust handling of all standard 5-field cron expressions.
 */
export function computeNextRunAt(cronSchedule: string, from?: Date): Date {
  const expression = CronExpressionParser.parse(cronSchedule, {
    currentDate: from ?? new Date(),
  });
  return expression.next().toDate();
}

/**
 * Validate a cron expression string.
 */
export function isValidCron(cronSchedule: string): boolean {
  try {
    CronExpressionParser.parse(cronSchedule);
    return true;
  } catch {
    return false;
  }
}
