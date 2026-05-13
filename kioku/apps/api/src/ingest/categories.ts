const CATEGORIES = [
  "personal_details",
  "family",
  "professional_details",
  "sports",
  "travel",
  "food",
  "music",
  "health",
  "technology",
  "hobbies",
  "fashion",
  "entertainment",
  "milestones",
  "user_preferences",
  "misc",
] as const;

const KNOWN_CATEGORIES = new Set<string>(CATEGORIES);

export const KIOKU_CATEGORIES: readonly string[] = CATEGORIES;

export function normalizeCategory(raw: string | undefined): string {
  if (!raw) return "misc";
  const c = raw.trim().toLowerCase();
  return KNOWN_CATEGORIES.has(c) ? c : "misc";
}
