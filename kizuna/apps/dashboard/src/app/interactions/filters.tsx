"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { searchPeopleAction, type PersonPickerResult } from "./actions";

const CHANNELS = ["email", "calendar", "in_person", "call", "message", "manual"] as const;

interface FiltersProps {
  initialChannel: string;
  initialPerson: { id: string; displayName: string } | null;
  basePath: string;
}

export function Filters({ initialChannel, initialPerson, basePath }: FiltersProps) {
  const router = useRouter();
  const [channel, setChannel] = useState<string>(initialChannel);
  const [pickerQuery, setPickerQuery] = useState<string>("");
  const [pickerResults, setPickerResults] = useState<PersonPickerResult[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const requestSeq = useRef(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const q = pickerQuery.trim();
    if (q.length === 0) {
      setPickerResults([]);
      return;
    }
    const seq = ++requestSeq.current;
    const handle = setTimeout(() => {
      startTransition(async () => {
        try {
          const results = await searchPeopleAction(q);
          if (seq === requestSeq.current) setPickerResults(results);
        } catch {
          if (seq === requestSeq.current) setPickerResults([]);
        }
      });
    }, 180);
    return () => clearTimeout(handle);
  }, [pickerQuery]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const navigate = (next: { channel?: string | null; personId?: string | null }) => {
    const params = new URLSearchParams();
    const effectiveChannel = next.channel !== undefined ? next.channel : channel;
    const effectivePerson =
      next.personId !== undefined ? next.personId : (initialPerson?.id ?? null);
    if (effectiveChannel) params.set("channel", effectiveChannel);
    if (effectivePerson) params.set("personId", effectivePerson);
    const qs = params.toString();
    router.push(qs ? `${basePath}?${qs}` : basePath);
  };

  return (
    <div ref={containerRef} className="flex flex-wrap items-center gap-2">
      <label className="text-xs text-muted-foreground">Channel</label>
      <select
        value={channel}
        onChange={(e) => {
          setChannel(e.target.value);
          navigate({ channel: e.target.value === "" ? null : e.target.value });
        }}
        className="h-9 rounded-md border border-border bg-card px-2 text-sm transition-colors focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/40"
      >
        <option value="">any</option>
        {CHANNELS.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>

      <label className="ml-2 text-xs text-muted-foreground">Person</label>
      {initialPerson ? (
        <span className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-sm">
          <span>{initialPerson.displayName}</span>
          <button
            type="button"
            onClick={() => navigate({ personId: null })}
            className="text-faint transition-colors hover:text-muted-foreground"
            aria-label="Clear person filter"
          >
            ×
          </button>
        </span>
      ) : (
        <div className="relative">
          <input
            type="text"
            value={pickerQuery}
            onChange={(e) => {
              setPickerQuery(e.target.value);
              setPickerOpen(true);
            }}
            onFocus={() => setPickerOpen(true)}
            placeholder="search by name / email"
            className="h-9 w-64 rounded-md border border-border bg-card px-3 text-sm shadow-xs placeholder:text-faint transition-colors focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/40"
          />
          {pickerOpen && pickerQuery.trim().length > 0 ? (
            <div className="absolute left-0 top-full z-10 mt-1 w-80 max-w-[90vw] overflow-hidden rounded-md border border-border bg-card shadow-md">
              {pending && pickerResults.length === 0 ? (
                <div className="px-3 py-2 text-xs text-faint">searching…</div>
              ) : pickerResults.length === 0 ? (
                <div className="px-3 py-2 text-xs text-faint">no matches</div>
              ) : (
                <ul className="max-h-64 overflow-auto">
                  {pickerResults.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setPickerOpen(false);
                          setPickerQuery("");
                          navigate({ personId: p.id });
                        }}
                        className="block w-full px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                      >
                        <span className="text-foreground">{p.displayName}</span>
                        {p.primaryEmail ? (
                          <span className="ml-2 text-xs text-faint">{p.primaryEmail}</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      )}

      {(initialChannel || initialPerson) && (
        <Button asChild variant="ghost" size="sm">
          <Link href={basePath}>clear</Link>
        </Button>
      )}
    </div>
  );
}
