// The canonical, version-controlled scope set per named grant. One Google
// identity, but each consumer gets its own refresh token consented for ONLY
// the scopes it needs — least privilege is explicit here, not implicit in
// whatever the last consent happened to request. Adding a consumer is a
// reviewable one-line change.
//
// Mirrors today's independent implementations exactly:
//   - kizuna: read-only Gmail + Calendar (apps/api/src/lib/google-auth.ts)
//   - kokoro: read Gmail + send + read/write Calendar (scripts/authorize-google.ts)
export const GRANT_REGISTRY = {
  kizuna: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
  ],
  kokoro: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar",
  ],
} as const satisfies Record<string, readonly string[]>;

export type GrantName = keyof typeof GRANT_REGISTRY;

export const GRANT_NAMES = Object.keys(GRANT_REGISTRY) as GrantName[];

export function isGrantName(value: string): value is GrantName {
  return Object.prototype.hasOwnProperty.call(GRANT_REGISTRY, value);
}

export function scopesFor(name: GrantName): string[] {
  return [...GRANT_REGISTRY[name]];
}
