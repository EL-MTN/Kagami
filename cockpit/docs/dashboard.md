# Cockpit Dashboard

Cockpit is the workspace-level operator view for Kagami. It lives at
`https://kagami.localhost` and intentionally stays thin: service health,
workspace attention items, and deep links into the owning dashboards.

## Page Map

| Route | Purpose                                  |
| ----- | ---------------------------------------- |
| `/`   | Workspace status cards + attention queue |

## Data Sources

| Service | Source                                                 | Used for                                    |
| ------- | ------------------------------------------------------ | ------------------------------------------- |
| Kioku   | `GET /health`, `GET /facts/count`                      | Memory service health + fact count          |
| Kokoro  | `GET /api/ops/summary` on the Kokoro dashboard         | Pending approvals, failed routines/watchers |
| Kizuna  | `GET /health`, `/oauth/google/status`, `/sync/*/state` | CRM API health, grant status, ingest state  |
| Kansoku | `GET /health`, `/v1/errors`                            | Observability health + open error groups    |
| Kao     | `GET /healthz`, bearer-gated `GET /grants`             | Identity service health + Google grants     |

Each fetch has a short timeout and failures are isolated, so one unavailable
service produces a down card and an attention row rather than breaking the page.

## Non-Goals

- Editing routines, watchers, facts, CRM people, or grants.
- Replacing the individual service dashboards.
- Persisting cockpit-local state.
- Cross-service mutation workflows.

## Configuration

Defaults target the Portless local URLs. Override only when running services
outside the normal Kagami dev topology.

```env
KIOKU_API_URL=https://api.kioku.localhost
KOKORO_DASHBOARD_URL=https://kokoro.localhost
KIZUNA_API_URL=https://api.kizuna.localhost
KANSOKU_API_URL=https://api.kansoku.localhost
KAO_API_URL=https://api.kao.localhost
KAO_TOKEN=
```
