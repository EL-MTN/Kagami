"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Search, Loader2, Calendar, FileText } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ScoreBar, ScoreLegend } from "@/components/score-bar";
import { EmptyState } from "@/components/shell";
import type { RankedFact } from "@/lib/api";

interface RecallResult {
  facts: RankedFact[];
  total: number;
}

export function RecallPlayground() {
  const [text, setText] = useState("");
  const [k, setK] = useState(10);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [result, setResult] = useState<RecallResult | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setPending(true);
    setError(null);
    const t0 = performance.now();
    try {
      const res = await fetch("/api/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: text, k }),
      });
      const json = (await res.json()) as RecallResult & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setResult(json);
      setElapsed(performance.now() - t0);
    } catch (err) {
      setError((err as Error).message);
      setResult(null);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-8">
      <form
        onSubmit={(e) => {
          void onSubmit(e);
        }}
        className="space-y-3"
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="A query — e.g. ‘what did I say about my sister's wedding?’"
          rows={3}
          className="font-display text-lg leading-relaxed"
        />
        <div className="flex items-center justify-between gap-4">
          <label className="inline-flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="kicker">Top-K</span>
            <input
              type="number"
              min={1}
              max={100}
              value={k}
              onChange={(e) => setK(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
              className="h-7 w-16 rounded-md border border-input bg-transparent px-2 font-mono text-xs tabular-nums focus:outline-none focus:ring-2 focus:ring-ring/50"
            />
          </label>
          <Button type="submit" disabled={pending || !text.trim()} size="sm">
            {pending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
              </>
            ) : (
              <>
                <Search className="h-3.5 w-3.5" /> Recall
              </>
            )}
          </Button>
        </div>
      </form>

      {error && (
        <div className="rounded-md border border-critical/30 bg-critical/5 px-4 py-3 text-xs text-critical">
          {error}
        </div>
      )}

      {result && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-baseline gap-3">
              <h3 className="kicker">Ranked facts</h3>
              <span className="text-[11px] tabular-nums text-faint">
                {result.facts.length} returned · {elapsed?.toFixed(0)}ms
              </span>
            </div>
            <ScoreLegend />
          </div>

          {result.facts.length === 0 ? (
            <EmptyState>No facts matched.</EmptyState>
          ) : (
            <ol className="stagger space-y-2.5">
              {result.facts.map((f, idx) => (
                <li
                  key={f.id}
                  className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-rule-strong"
                >
                  <div className="flex items-start gap-4">
                    <span className="font-display text-2xl leading-none text-faint tabular-nums w-8 shrink-0">
                      {idx + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/facts/${f.id}`}
                        className="block text-sm leading-relaxed text-foreground transition-colors hover:text-primary"
                      >
                        {f.text}
                      </Link>
                      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] tabular-nums text-faint">
                        <span className="inline-flex items-center gap-1.5">
                          <Calendar className="h-3 w-3" strokeWidth={1.75} />
                          {f.event_date || "—"}
                        </span>
                        <span className="inline-flex items-center gap-1.5 truncate">
                          <FileText className="h-3 w-3" strokeWidth={1.75} />
                          <span className="truncate font-mono">{f.source_session}</span>
                        </span>
                      </div>
                      {(f.score !== undefined ||
                        f.semantic !== undefined ||
                        f.bm25 !== undefined ||
                        f.entity_boost !== undefined) && (
                        <div className="mt-3">
                          <ScoreBar
                            score={f.score}
                            semantic={f.semantic}
                            bm25={f.bm25}
                            entityBoost={f.entity_boost}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}
