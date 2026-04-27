import cronstrue from "cronstrue";

/**
 * Human-readable description of a cron expression, or null if invalid/empty.
 * Use to render preview text under cron inputs.
 */
export function describeCron(expr: string | null | undefined): string | null {
  if (!expr) return null;
  try {
    return cronstrue.toString(expr, { use24HourTimeFormat: false, verbose: true });
  } catch {
    return null;
  }
}

/**
 * Label suitable for a table cell — falls back to "on-demand" for null and
 * the raw expression if cronstrue can't parse it (so the user still sees what
 * they typed).
 */
export function cronLabel(expr: string | null | undefined): string {
  if (!expr) return "on-demand";
  return describeCron(expr) ?? expr;
}
