import { z, ZodError } from "zod";
import { config, tracedFetch } from "@kokoro/shared";

type KizunaClientErrorKind = "timeout" | "transport" | "http" | "schema";

export class KizunaClientError extends Error {
  constructor(
    public readonly kind: KizunaClientErrorKind,
    public readonly safeMessage: string,
    public readonly metadata: {
      status?: number;
      routeTemplate?: string;
      pathAndQuery?: string;
      body?: unknown;
    } = {},
  ) {
    super(safeMessage);
    this.name = "KizunaClientError";
  }

  get status(): number | undefined {
    return this.metadata.status;
  }

  get routeTemplate(): string | undefined {
    return this.metadata.routeTemplate;
  }
}

export const KIZUNA_TIMEOUT_MS = 10_000;

type Deadline = {
  signal: AbortSignal;
  done: () => void;
};

function baseUrl(): string {
  return config.KIZUNA_URL.replace(/\/+$/, "");
}

function createKizunaDeadline(): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KIZUNA_TIMEOUT_MS);
  return {
    signal: controller.signal,
    done: () => clearTimeout(timer),
  };
}

export async function withKizunaDeadline<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = createKizunaDeadline();
  try {
    return await fn(deadline.signal);
  } finally {
    deadline.done();
  }
}

async function parseErrorBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return await res.text().catch(() => null);
  }
}

function classifyFetchError(
  err: unknown,
  pathAndQuery: string,
  routeTemplate: string,
): KizunaClientError {
  if (err instanceof KizunaClientError) return err;
  if (err instanceof ZodError) {
    return new KizunaClientError("schema", "Kizuna response schema mismatch", {
      pathAndQuery,
      routeTemplate,
    });
  }
  if (err instanceof Error && err.name === "AbortError") {
    return new KizunaClientError("timeout", "Kizuna request timed out", {
      pathAndQuery,
      routeTemplate,
    });
  }
  return new KizunaClientError("transport", "Kizuna transport error", {
    pathAndQuery,
    routeTemplate,
  });
}

export async function getJson<T>(
  pathAndQuery: string,
  routeTemplate: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<T> {
  try {
    // tracedFetch stamps the active W3C traceparent so Kizuna's trace
    // middleware can link this call into the same trace as the inbound update.
    const res = await tracedFetch(`${baseUrl()}${pathAndQuery}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal,
    });
    if (!res.ok) {
      throw new KizunaClientError("http", `Kizuna request failed with status ${res.status}`, {
        status: res.status,
        routeTemplate,
        pathAndQuery,
        body: await parseErrorBody(res),
      });
    }
    return schema.parse(await res.json());
  } catch (err) {
    throw classifyFetchError(err, pathAndQuery, routeTemplate);
  }
}

export async function sendJson<T>(
  method: "POST" | "PATCH" | "DELETE",
  pathAndQuery: string,
  routeTemplate: string,
  body: unknown,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<T> {
  try {
    const res = await tracedFetch(`${baseUrl()}${pathAndQuery}`, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      throw new KizunaClientError("http", `Kizuna request failed with status ${res.status}`, {
        status: res.status,
        routeTemplate,
        pathAndQuery,
        body: await parseErrorBody(res),
      });
    }
    return schema.parse(await res.json());
  } catch (err) {
    throw classifyFetchError(err, pathAndQuery, routeTemplate);
  }
}

export function appendParam(params: URLSearchParams, key: string, value: string | undefined) {
  if (value !== undefined) params.set(key, value);
}

export function clampLimit(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
) {
  if (value === undefined || Number.isNaN(value)) return defaultValue;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
