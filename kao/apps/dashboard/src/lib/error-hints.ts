// Operator-facing hint per Kao API error code. Mirrors the vend-route taxonomy
// in api/src/routes/grants.ts so the dashboard can tell the operator what to
// do without making them go read the API source. Shared so probe and revoke
// surface the same hint for the same code — operators shouldn't see different
// help for "misconfigured" depending on which button they pressed.
export function hintFor(code: string): string | null {
  switch (code) {
    case "no_grant":
      return "No active refresh token. Click Connect Google to grant consent.";
    case "invalid_grant":
      return "Google rejected the stored refresh token. Click Re-consent to grant a fresh one.";
    case "decrypt_failed":
      return "Kao can't decrypt the stored refresh token (likely a rotated KAO_ENCRYPTION_KEY). Re-consent to overwrite it.";
    case "bad_gateway":
      return "Transient failure talking to Google. Try again in a few seconds.";
    case "unauthorized":
      return "Dashboard bearer (KAO_TOKEN) doesn't match the API's. Check apps/dashboard/.env.";
    case "unreachable":
      return "Couldn't reach the Kao API at all. Is it running?";
    case "misconfigured":
      return "Dashboard env is incomplete — copy apps/dashboard/.env.example and fill in KAO_TOKEN.";
    case "not_found":
      return "The Kao API no longer recognizes this grant — it may have been removed from the registry.";
    case "malformed_response":
      return "The Kao API returned an unexpected response body. Check the API logs and any reverse proxy in front of it.";
    default:
      return null;
  }
}
