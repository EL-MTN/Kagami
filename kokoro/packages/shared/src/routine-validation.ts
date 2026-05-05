import { CronExpressionParser } from "cron-parser";

interface RoutineParameterLike {
  name: string;
  required: boolean;
  default?: unknown;
}

function isValidCron(cronSchedule: string): boolean {
  try {
    CronExpressionParser.parse(cronSchedule);
    return true;
  } catch {
    return false;
  }
}

export function computeNextRunAt(cronSchedule: string, from?: Date): Date {
  return CronExpressionParser.parse(cronSchedule, {
    currentDate: from ?? new Date(),
  })
    .next()
    .toDate();
}

export type CronValidationError =
  | { kind: "invalid-cron"; message: string }
  | { kind: "missing-defaults"; missing: string[]; message: string };

export function validateCronAndDefaults(
  cronSchedule: string | null | undefined,
  parameters: RoutineParameterLike[],
): CronValidationError | null {
  if (!cronSchedule) return null;
  if (!isValidCron(cronSchedule)) {
    return { kind: "invalid-cron", message: `Invalid cron expression: "${cronSchedule}"` };
  }
  const missing = parameters
    .filter((p) => p.required && p.default === undefined)
    .map((p) => p.name);
  if (missing.length > 0) {
    return {
      kind: "missing-defaults",
      missing,
      message: `Cron-scheduled routines require defaults for all required parameters. Missing: ${missing.join(", ")}`,
    };
  }
  return null;
}
