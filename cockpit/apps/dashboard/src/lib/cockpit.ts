import type { AttentionItem, CockpitData, ServiceCard, ServiceId } from "./types";
import { fmtNumber, shortError } from "./format";

const DEFAULT_TIMEOUT_MS = 2_500;

const URLS = {
  kiokuApi: trimOrigin(process.env.KIOKU_API_URL ?? "https://api.kioku.localhost"),
  kokoroDashboard: trimOrigin(process.env.KOKORO_DASHBOARD_URL ?? "https://kokoro.localhost"),
  kizunaApi: trimOrigin(process.env.KIZUNA_API_URL ?? "https://api.kizuna.localhost"),
  kansokuApi: trimOrigin(process.env.KANSOKU_API_URL ?? "https://api.kansoku.localhost"),
  kaoApi: trimOrigin(process.env.KAO_API_URL ?? "https://api.kao.localhost"),
};

const DASHBOARDS: Record<ServiceId, string> = {
  kioku: "https://kioku.localhost",
  kokoro: URLS.kokoroDashboard,
  kizuna: "https://kizuna.localhost",
  kansoku: "https://kansoku.localhost",
  kao: "https://kao.localhost",
};

interface HealthOk {
  ok?: boolean;
  status?: string;
}

interface KiokuCount {
  count: number;
}

interface KokoroOpsSummary {
  pendingConfirmations: number;
  staleConfirmations: number;
  enabledRoutines: number;
  enabledWatchers: number;
  failedRoutines: Array<{
    id: string;
    name: string | null;
    summary: string | null;
    startedAt: string;
  }>;
  failedWatchers: Array<{
    id: string;
    name: string | null;
    summary: string | null;
    startedAt: string;
  }>;
}

type OAuthStatus =
  | { granted: false; reason?: "kao_unauthorized" | "kao_unreachable" }
  | { granted: true; scopes: string[]; grantedAt: string | null };

interface SyncState {
  provider: "gmail" | "gcal";
  lastRunAt: string | null;
  errorCount: number;
  lastError: string | null;
  pausedAt: string | null;
}

interface KansokuError {
  _id: string;
  service: string;
  component: string;
  name?: string;
  message: string;
  lastSeen: string;
  count: number;
}

interface KaoGrant {
  name: string;
  granted: boolean;
  scopes: string[];
  grantedAt: string | null;
  revokedAt: string | null;
}

function trimOrigin(value: string): string {
  return value.replace(/\/+$/, "");
}

function nowIso(): string {
  return new Date().toISOString();
}

function serviceError(
  id: ServiceId,
  name: string,
  kanji: string,
  role: string,
  href: string,
  error: unknown,
): { service: ServiceCard; attention: AttentionItem[] } {
  const checkedAt = nowIso();
  const detail = shortError(error instanceof Error ? error.message : String(error));
  return {
    service: {
      id,
      name,
      kanji,
      role,
      href,
      state: "down",
      summary: "Unavailable",
      detail,
      checkedAt,
    },
    attention: [
      {
        id: `${id}:down`,
        service: id,
        severity: "critical",
        title: `${name} is unavailable`,
        detail,
        href,
        detectedAt: checkedAt,
      },
    ],
  };
}

async function json<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const compact = text.replace(/\s+/g, " ").trim();
    const bodyPreview =
      compact.startsWith("<!DOCTYPE") || compact.startsWith("<html")
        ? ""
        : ` ${compact.slice(0, 180)}`;
    throw new Error(`${path} -> ${res.status} ${res.statusText}${bodyPreview}`);
  }
  return res.json() as Promise<T>;
}

async function readKioku(): Promise<{ service: ServiceCard; attention: AttentionItem[] }> {
  const checkedAt = nowIso();
  try {
    const [health, count] = await Promise.all([
      json<HealthOk>(URLS.kiokuApi, "/health"),
      json<KiokuCount>(URLS.kiokuApi, "/facts/count"),
    ]);
    const ok = health.ok === true || health.status === "ok";
    return {
      service: {
        id: "kioku",
        name: "Kioku",
        kanji: "憶",
        role: "Memory",
        href: `${DASHBOARDS.kioku}/facts`,
        state: ok ? "ok" : "warn",
        summary: ok ? "Memory API healthy" : "Health probe returned an unexpected shape",
        metric: { label: "facts", value: fmtNumber(count.count) },
        checkedAt,
      },
      attention: ok
        ? []
        : [
            {
              id: "kioku:health-shape",
              service: "kioku",
              severity: "warning",
              title: "Kioku health probe returned an unexpected shape",
              href: `${DASHBOARDS.kioku}/health`,
              detectedAt: checkedAt,
            },
          ],
    };
  } catch (error) {
    return serviceError("kioku", "Kioku", "憶", "Memory", `${DASHBOARDS.kioku}/health`, error);
  }
}

async function readKokoro(): Promise<{ service: ServiceCard; attention: AttentionItem[] }> {
  const checkedAt = nowIso();
  try {
    const summary = await json<KokoroOpsSummary>(URLS.kokoroDashboard, "/api/ops/summary");
    const failures = summary.failedRoutines.length + summary.failedWatchers.length;
    const pending = summary.pendingConfirmations;
    const attention: AttentionItem[] = [];

    if (pending > 0) {
      attention.push({
        id: "kokoro:pending-confirmations",
        service: "kokoro",
        severity: summary.staleConfirmations > 0 ? "warning" : "info",
        title: `${pending} pending ${pending === 1 ? "approval" : "approvals"}`,
        detail:
          summary.staleConfirmations > 0
            ? `${summary.staleConfirmations} pending for over an hour`
            : undefined,
        href: `${DASHBOARDS.kokoro}/confirmations`,
        detectedAt: checkedAt,
      });
    }

    for (const item of summary.failedRoutines.slice(0, 3)) {
      attention.push({
        id: `kokoro:routine:${item.id}`,
        service: "kokoro",
        severity: "warning",
        title: `Routine failed${item.name ? `: ${item.name}` : ""}`,
        detail: item.summary ?? undefined,
        href: `${DASHBOARDS.kokoro}/routines`,
        detectedAt: item.startedAt,
      });
    }

    for (const item of summary.failedWatchers.slice(0, 3)) {
      attention.push({
        id: `kokoro:watcher:${item.id}`,
        service: "kokoro",
        severity: "warning",
        title: `Watcher failed${item.name ? `: ${item.name}` : ""}`,
        detail: item.summary ?? undefined,
        href: `${DASHBOARDS.kokoro}/watchers`,
        detectedAt: item.startedAt,
      });
    }

    return {
      service: {
        id: "kokoro",
        name: "Kokoro",
        kanji: "心",
        role: "Agent",
        href: DASHBOARDS.kokoro,
        state: failures > 0 || summary.staleConfirmations > 0 ? "warn" : "ok",
        summary:
          pending > 0
            ? `${pending} approval${pending === 1 ? "" : "s"} waiting`
            : "Agent dashboard responsive",
        detail: `${summary.enabledRoutines} routines, ${summary.enabledWatchers} watchers enabled`,
        metric: { label: "attention", value: failures + pending },
        checkedAt,
      },
      attention,
    };
  } catch (error) {
    return serviceError("kokoro", "Kokoro", "心", "Agent", DASHBOARDS.kokoro, error);
  }
}

async function readKizuna(): Promise<{ service: ServiceCard; attention: AttentionItem[] }> {
  const checkedAt = nowIso();
  try {
    const [health, oauth, gmail, gcal] = await Promise.all([
      json<HealthOk>(URLS.kizunaApi, "/health"),
      json<OAuthStatus>(URLS.kizunaApi, "/oauth/google/status"),
      json<SyncState>(URLS.kizunaApi, "/sync/gmail/state"),
      json<SyncState>(URLS.kizunaApi, "/sync/gcal/state"),
    ]);
    const ok = health.ok === true || health.status === "ok";
    const attention: AttentionItem[] = [];

    if (!oauth.granted) {
      attention.push({
        id: "kizuna:oauth",
        service: "kizuna",
        severity:
          oauth.reason === "kao_unauthorized" || oauth.reason === "kao_unreachable"
            ? "critical"
            : "warning",
        title: "Kizuna Google grant is not active",
        detail: oauth.reason ? `Reason: ${oauth.reason}` : undefined,
        href: `${DASHBOARDS.kizuna}/sync`,
        detectedAt: checkedAt,
      });
    }

    for (const state of [gmail, gcal]) {
      if (state.pausedAt || state.lastError || state.errorCount > 0) {
        attention.push({
          id: `kizuna:sync:${state.provider}`,
          service: "kizuna",
          severity: state.pausedAt ? "critical" : "warning",
          title: `${state.provider === "gmail" ? "Gmail" : "Calendar"} sync needs attention`,
          detail: state.lastError ?? `${state.errorCount} recorded errors`,
          href: `${DASHBOARDS.kizuna}/errors`,
          detectedAt: state.pausedAt ?? state.lastRunAt ?? checkedAt,
        });
      }
    }

    return {
      service: {
        id: "kizuna",
        name: "Kizuna",
        kanji: "絆",
        role: "CRM",
        href: `${DASHBOARDS.kizuna}/today`,
        state: ok && attention.length === 0 ? "ok" : "warn",
        summary: oauth.granted ? "CRM and Google ingest visible" : "Grant attention needed",
        detail: `Gmail ${syncLabel(gmail)}, Calendar ${syncLabel(gcal)}`,
        metric: { label: "sync issues", value: attention.length },
        checkedAt,
      },
      attention,
    };
  } catch (error) {
    return serviceError("kizuna", "Kizuna", "絆", "CRM", `${DASHBOARDS.kizuna}/errors`, error);
  }
}

function syncLabel(state: SyncState): string {
  if (state.pausedAt) return "paused";
  if (state.lastError || state.errorCount > 0) return "warning";
  if (state.lastRunAt) return "ok";
  return "idle";
}

async function readKansoku(): Promise<{ service: ServiceCard; attention: AttentionItem[] }> {
  const checkedAt = nowIso();
  try {
    const [health, errors] = await Promise.all([
      json<HealthOk>(URLS.kansokuApi, "/health"),
      json<{ errors: KansokuError[] }>(URLS.kansokuApi, "/v1/errors?limit=25"),
    ]);
    const ok = health.ok === true || health.status === "ok";
    const attention = errors.errors.slice(0, 6).map<AttentionItem>((err) => ({
      id: `kansoku:error:${err._id}`,
      service: "kansoku",
      severity: err.count >= 10 ? "critical" : "warning",
      title: `${err.service}: ${err.name ?? "Error"}`,
      detail: `${err.message} (${err.count}×)`,
      href:
        err._id && err._id.length > 0
          ? `${DASHBOARDS.kansoku}/errors?service=${encodeURIComponent(err.service)}`
          : `${DASHBOARDS.kansoku}/errors`,
      detectedAt: err.lastSeen,
    }));

    return {
      service: {
        id: "kansoku",
        name: "Kansoku",
        kanji: "観",
        role: "Observability",
        href: `${DASHBOARDS.kansoku}/errors`,
        state: ok && attention.length === 0 ? "ok" : "warn",
        summary:
          attention.length > 0 ? `${attention.length} error groups open` : "Observability healthy",
        metric: { label: "error groups", value: errors.errors.length },
        checkedAt,
      },
      attention,
    };
  } catch (error) {
    return serviceError(
      "kansoku",
      "Kansoku",
      "観",
      "Observability",
      `${DASHBOARDS.kansoku}/errors`,
      error,
    );
  }
}

async function readKao(): Promise<{ service: ServiceCard; attention: AttentionItem[] }> {
  const checkedAt = nowIso();
  try {
    const health = await json<HealthOk>(URLS.kaoApi, "/healthz");
    const ok = health.ok === true || health.status === "ok";
    const token = process.env.KAO_TOKEN?.trim() ?? "";
    const attention: AttentionItem[] = [];

    if (token.length < 16) {
      attention.push({
        id: "kao:token-missing",
        service: "kao",
        severity: "warning",
        title: "Cockpit cannot read Kao grants",
        detail: "Set KAO_TOKEN for the cockpit dashboard to inspect grant status.",
        href: DASHBOARDS.kao,
        detectedAt: checkedAt,
      });
      return {
        service: {
          id: "kao",
          name: "Kao",
          kanji: "顔",
          role: "Identity",
          href: DASHBOARDS.kao,
          state: "warn",
          summary: ok ? "Identity API healthy" : "Health probe returned an unexpected shape",
          detail: "Grant visibility not configured",
          checkedAt,
        },
        attention,
      };
    }

    const grants = await json<{ grants: KaoGrant[] }>(URLS.kaoApi, "/grants", {
      headers: { authorization: `Bearer ${token}` },
    });

    for (const grant of grants.grants) {
      if (!grant.granted) {
        attention.push({
          id: `kao:grant:${grant.name}`,
          service: "kao",
          severity: "critical",
          title: `Kao grant missing: ${grant.name}`,
          detail: grant.revokedAt ? `Revoked ${grant.revokedAt}` : "No active refresh token",
          href: `${DASHBOARDS.kao}/grants/${encodeURIComponent(grant.name)}`,
          detectedAt: grant.revokedAt ?? checkedAt,
        });
      }
    }

    return {
      service: {
        id: "kao",
        name: "Kao",
        kanji: "顔",
        role: "Identity",
        href: DASHBOARDS.kao,
        state: ok && attention.length === 0 ? "ok" : "warn",
        summary: attention.length > 0 ? "Grant attention needed" : "Google grants active",
        metric: { label: "grants", value: grants.grants.length },
        checkedAt,
      },
      attention,
    };
  } catch (error) {
    return serviceError("kao", "Kao", "顔", "Identity", DASHBOARDS.kao, error);
  }
}

const severityWeight: Record<AttentionItem["severity"], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export async function getCockpitData(): Promise<CockpitData> {
  const checkedAt = nowIso();
  const results = await Promise.all([
    readKioku(),
    readKokoro(),
    readKizuna(),
    readKansoku(),
    readKao(),
  ]);

  const services = results.map((r) => r.service);
  const attention = results
    .flatMap((r) => r.attention)
    .sort((a, b) => {
      const severity = severityWeight[a.severity] - severityWeight[b.severity];
      if (severity !== 0) return severity;
      return new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime();
    });

  return { checkedAt, services, attention };
}
