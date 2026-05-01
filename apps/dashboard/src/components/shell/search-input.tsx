"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

interface ControlledProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

interface URLProps {
  /** Query-string parameter name to bind to. */
  param: string;
  placeholder?: string;
  className?: string;
  /** Debounce in ms; default 250. */
  debounceMs?: number;
  /** Extra params to keep when pushing — e.g. when search resets pagination. */
  resetParams?: string[];
}

type SearchInputProps = ControlledProps | URLProps;

function isURLProps(p: SearchInputProps): p is URLProps {
  return "param" in p;
}

export function SearchInput(props: SearchInputProps) {
  if (isURLProps(props)) return <URLSearchInput {...props} />;
  return (
    <SearchShell
      value={props.value}
      onChange={props.onChange}
      placeholder={props.placeholder}
      className={props.className}
    />
  );
}

function SearchShell({
  value,
  onChange,
  placeholder = "Search",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`h-8 w-56 pl-7 text-xs ${className ?? ""}`}
      />
    </div>
  );
}

function URLSearchInput({
  param,
  placeholder,
  className,
  debounceMs = 250,
  resetParams = ["page"],
}: URLProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initial = searchParams.get(param) ?? "";
  const [value, setValue] = useState(initial);

  // Refs so the effect only re-runs on `value` changes, not on every render
  // (which would happen if these were in the deps array — `resetParams` is a
  // fresh array per render, `searchParams` changes whenever the URL does).
  const ctxRef = useRef({ param, pathname, router, searchParams, debounceMs, resetParams });
  ctxRef.current = { param, pathname, router, searchParams, debounceMs, resetParams };
  const isFirstRun = useRef(true);

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    const ctx = ctxRef.current;
    const t = setTimeout(() => {
      const next = new URLSearchParams(ctx.searchParams.toString());
      if (value) next.set(ctx.param, value);
      else next.delete(ctx.param);
      for (const p of ctx.resetParams) next.delete(p);
      const qs = next.toString();
      const target = qs ? `${ctx.pathname}?${qs}` : ctx.pathname;
      ctx.router.replace(target, { scroll: false });
    }, ctx.debounceMs);
    return () => clearTimeout(t);
  }, [value]);

  return (
    <SearchShell
      value={value}
      onChange={setValue}
      placeholder={placeholder}
      className={className}
    />
  );
}
