export function appendAnd(filter: Record<string, unknown>, condition: Record<string, unknown>) {
  filter.$and = [...((filter.$and as Array<Record<string, unknown>> | undefined) ?? []), condition];
}
