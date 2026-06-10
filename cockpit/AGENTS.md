# Cockpit

Cockpit is Kagami's thin workspace operator surface. It is not a domain
service and owns no durable state; it reads the five sibling services and points
operators back to the dashboard that owns each fix.

## Scope

- Keep the cockpit read-only unless a future change explicitly adds a
  cross-service operation.
- Prefer existing service APIs over direct database imports. If a service lacks
  a small operator summary surface, add that route to the owning service rather
  than coupling Cockpit to its internals.
- Do not duplicate detailed service dashboards. The cockpit should answer
  "what needs attention?" and deep-link to Kioku, Kokoro, Kizuna, Kansoku, or
  Kao for the actual workflow.

## Running

From the Kagami root:

```bash
npm run cockpit:dev:dashboard
```

Portless serves the dashboard at `https://kagami.localhost`.

## Configuration

Env vars are declared in `apps/dashboard/src/env.ts` (an `@kagami/env` spec);
the generated table lives in [docs/configuration.md](docs/configuration.md).
All service URLs default to the Portless topology, so no `.env` is required;
`KAO_TOKEN` is the only var worth setting (it unlocks Kao grant status).
`apps/dashboard/.env.example` and `apps/dashboard/turbo.json` are generated —
edit `src/env.ts`, then `npm run env:gen`.

## Design

Follow the existing Kagami Daylight dashboard family: Instrument Serif for the
wordmark/title, DM Sans for UI text, JetBrains Mono for scannable numbers and
timestamps, warm-paper OKLch tokens, and restrained operational density.
