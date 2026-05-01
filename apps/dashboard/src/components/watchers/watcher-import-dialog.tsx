"use client";

import { useState, useRef, type DragEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Upload } from "lucide-react";
import { watcherExportBundleSchema, type WatcherExportBundle } from "@/lib/watcher-schema";

interface ApiImportResponse {
  error?: string;
  imported?: number;
  skipped?: number;
  errors?: string[];
}

type ImportState =
  | { step: "idle" }
  | { step: "preview"; bundle: WatcherExportBundle }
  | { step: "importing" }
  | { step: "result"; imported: number; skipped: number; errors: string[] };

interface WatcherImportDialogProps {
  onImported: () => void;
}

export function WatcherImportDialog({ onImported }: WatcherImportDialogProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ImportState>({ step: "idle" });
  const [parseError, setParseError] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function reset() {
    setState({ step: "idle" });
    setParseError(null);
    setPasteValue("");
    setDragOver(false);
  }

  function tryParse(text: string) {
    setParseError(null);
    try {
      const json: unknown = JSON.parse(text);
      const result = watcherExportBundleSchema.safeParse(json);
      if (result.success) {
        setState({ step: "preview", bundle: result.data });
      } else {
        setParseError(result.error.issues.map((i) => i.message).join(", "));
      }
    } catch {
      setParseError("Invalid JSON");
    }
  }

  async function readFileAsText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void readFileAsText(file).then(tryParse);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void readFileAsText(file).then(tryParse);
  }

  function handlePaste(value: string) {
    setPasteValue(value);
    if (value.trim()) {
      tryParse(value);
    } else {
      setState({ step: "idle" });
      setParseError(null);
    }
  }

  async function handleImport() {
    if (state.step !== "preview") return;
    setState({ step: "importing" });

    try {
      const res = await fetch("/api/watchers?action=import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.bundle),
      });
      const data = (await res.json()) as ApiImportResponse;

      if (!res.ok) {
        setParseError(data.error ?? "Import failed");
        setState({ step: "idle" });
        return;
      }

      setState({
        step: "result",
        imported: data.imported ?? 0,
        skipped: data.skipped ?? 0,
        errors: data.errors ?? [],
      });
      onImported();
    } catch {
      setParseError("Network error");
      setState({ step: "idle" });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Upload className="h-3.5 w-3.5" />
          Import
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Import Watchers</DialogTitle>
        </DialogHeader>

        {state.step === "result" ? (
          <div className="space-y-3">
            <p className="text-sm text-foreground/90">
              Imported <strong>{state.imported}</strong> watcher
              {state.imported !== 1 ? "s" : ""}
              {state.skipped > 0 && (
                <>
                  , skipped <strong>{state.skipped}</strong> (duplicate name)
                </>
              )}
            </p>
            {state.errors.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs text-destructive-foreground">Errors:</p>
                {state.errors.map((err, i) => (
                  <p key={i} className="text-xs text-destructive-foreground/80">
                    {err}
                  </p>
                ))}
              </div>
            )}
            <DialogFooter>
              <Button
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div
              className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 transition-colors ${
                dragOver ? "border-primary/40 bg-primary/5" : "border-border hover:border-border/80"
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-8 w-8 text-faint" />
              <p className="text-xs text-muted-foreground">
                Drop a JSON file here or click to browse
              </p>
              <input
                ref={fileRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={handleFileSelect}
              />
            </div>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-[10px]">
                <span className="bg-background px-3 uppercase tracking-wider text-faint">
                  or paste JSON
                </span>
              </div>
            </div>

            <Textarea
              value={pasteValue}
              onChange={(e) => handlePaste(e.target.value)}
              placeholder='{"version": 1, "watchers": [...]}'
              className="min-h-[100px] font-mono text-xs"
            />

            {parseError && <p className="text-xs text-destructive-foreground">{parseError}</p>}

            {state.step === "preview" && (
              <div className="space-y-2">
                <p className="text-sm text-foreground/90">
                  Found <strong>{state.bundle.watchers.length}</strong> watcher
                  {state.bundle.watchers.length !== 1 ? "s" : ""}:
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {state.bundle.watchers.map((w) => (
                    <span
                      key={w.name}
                      className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs text-primary/80"
                    >
                      {w.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
              >
                Cancel
              </Button>
              <Button onClick={() => void handleImport()} disabled={state.step !== "preview"}>
                {state.step === "importing" ? "Importing..." : "Import"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
