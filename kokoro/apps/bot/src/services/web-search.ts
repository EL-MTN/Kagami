import { config, logger } from "@kokoro/shared";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Brave's `description` field is plaintext-with-HTML — it may contain
 * `<strong>` tags wrapping query-term highlights. Strip them so the snippet
 * looks clean when the LLM renders it back to the user.
 */
function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

/**
 * Search the web via the Brave Search API. Throws on missing config or any
 * non-2xx response so the caller can surface a clean reason to the LLM.
 *
 * `count` is clamped to Brave's documented 1–20 range as a safety net. The
 * tool wrapper applies a tighter policy cap (currently 1–10) before calling;
 * this layer only enforces what Brave itself accepts. Default is 5.
 */
export async function webSearch(
  query: string,
  options: { count?: number } = {},
): Promise<WebSearchResult[]> {
  const apiKey = config.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error("BRAVE_SEARCH_API_KEY is not configured");
  }

  const count = Math.max(1, Math.min(20, options.count ?? 5));
  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${count}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: controller.signal,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "network error";
    throw new Error(`Brave search request failed: ${reason}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (res.status === 401) throw new Error("Brave search rejected the API key (401)");
    if (res.status === 429) throw new Error("Brave search rate limit exceeded (429)");
    throw new Error(`Brave search returned ${res.status}`);
  }

  const data = (await res.json()) as BraveResponse;
  const raw = data.web?.results ?? [];

  const results: WebSearchResult[] = [];
  for (const r of raw) {
    if (!r.title || !r.url) continue;
    results.push({
      title: stripHtml(r.title),
      url: r.url,
      snippet: stripHtml(r.description ?? ""),
    });
  }

  logger.info({ query, count: results.length }, "Brave search returned results");
  return results;
}
