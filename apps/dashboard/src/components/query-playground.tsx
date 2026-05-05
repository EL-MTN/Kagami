"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Sparkles, Loader2, Calendar } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ScoreBar } from "@/components/score-bar";
import { EmptyState } from "@/components/shell";
import type { RankedFact } from "@/lib/api";

interface QueryResult {
  answer: string;
  citations?: string[];
  facts?: RankedFact[];
}

export function QueryPlayground() {
  const [text, setText] = useState("");
  const [k, setK] = useState(50);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setPending(true);
    setError(null);
    const t0 = performance.now();
    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text, k }),
      });
      const json = (await res.json()) as QueryResult & { error?: string };
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
          placeholder="Ask a question — full hybrid retrieval + answerer."
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
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Answering…
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" /> Ask
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
        <div className="space-y-8">
          <section className="relative overflow-hidden rounded-xl border border-border bg-card p-7">
            <span className="absolute left-0 top-0 h-full w-[3px] bg-primary" />
            <div className="flex items-center justify-between">
              <h3 className="kicker">Answer</h3>
              <span className="text-[11px] tabular-nums text-faint">
                {elapsed?.toFixed(0)}ms
                {result.facts && ` · ${result.facts.length} sources`}
              </span>
            </div>
            <p className="mt-4 font-display text-2xl leading-relaxed text-foreground whitespace-pre-wrap">
              {result.answer}
            </p>
          </section>

          <section className="space-y-3">
            <h3 className="kicker">Supporting facts</h3>
            {!result.facts || result.facts.length === 0 ? (
              <EmptyState>
                The /query endpoint doesn&apos;t expose its top-K facts. Use{" "}
                <a href="/recall" className="text-primary hover:underline">
                  Recall
                </a>{" "}
                to inspect ranking directly.
              </EmptyState>
            ) : (
              <ol className="stagger space-y-2">
                {result.facts.map((f, idx) => (
                  <li
                    key={f.id}
                    className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-rule-strong"
                  >
                    <div className="flex items-start gap-3">
                      <span className="font-mono text-[11px] tabular-nums text-faint w-5 shrink-0 pt-0.5">
                        {idx + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/facts/${f.id}`}
                          className="block text-sm leading-relaxed text-foreground transition-colors hover:text-primary"
                        >
                          {f.text}
                        </Link>
                        <div className="mt-1.5 flex items-center gap-3 text-[11px] tabular-nums text-faint">
                          <span className="inline-flex items-center gap-1">
                            <Calendar className="h-3 w-3" strokeWidth={1.75} />
                            {f.event_date || "—"}
                          </span>
                        </div>
                      </div>
                      <div className="w-44 shrink-0 pt-1">
                        <ScoreBar
                          score={f.score}
                          semantic={f.semantic}
                          bm25={f.bm25}
                          entityBoost={f.entity_boost}
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
