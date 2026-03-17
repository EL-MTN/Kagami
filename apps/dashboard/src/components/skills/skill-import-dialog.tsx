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
import { Badge } from "@/components/ui/badge";
import { Upload } from "lucide-react";
import { skillExportBundleSchema, type SkillExportBundle } from "@/lib/skill-schema";

interface ApiImportResponse {
  error?: string;
  imported?: number;
  skipped?: number;
  errors?: string[];
}

type ImportState =
  | { step: "idle" }
  | { step: "preview"; bundle: SkillExportBundle }
  | { step: "importing" }
  | { step: "result"; imported: number; skipped: number; errors: string[] };

interface SkillImportDialogProps {
  onImported: () => void;
}

export function SkillImportDialog({ onImported }: SkillImportDialogProps) {
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
      const result = skillExportBundleSchema.safeParse(json);
      if (result.success) {
        setState({ step: "preview", bundle: result.data });
      } else {
        setParseError(result.error.issues.map((i) => i.message).join(", "));
      }
    } catch {
      setParseError("Invalid JSON");
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => tryParse(reader.result as string);
      reader.readAsText(file);
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => tryParse(reader.result as string);
      reader.readAsText(file);
    }
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
      const res = await fetch("/api/skills?action=import", {
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
          <Upload className="h-4 w-4" />
          Import
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import Skills</DialogTitle>
        </DialogHeader>

        {state.step === "result" ? (
          <div className="space-y-3">
            <p className="text-sm">
              Imported <strong>{state.imported}</strong> skill
              {state.imported !== 1 ? "s" : ""}
              {state.skipped > 0 && (
                <>
                  , skipped <strong>{state.skipped}</strong> (duplicate name)
                </>
              )}
            </p>
            {state.errors.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm text-destructive">Errors:</p>
                {state.errors.map((err, i) => (
                  <p key={i} className="text-xs text-destructive">
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
            {/* Drop zone */}
            <div
              className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 transition-colors ${
                dragOver ? "border-primary bg-primary/5" : "border-border"
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
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
              <div className="relative flex justify-center text-xs">
                <span className="bg-background px-2 text-muted-foreground">or paste JSON</span>
              </div>
            </div>

            <Textarea
              value={pasteValue}
              onChange={(e) => handlePaste(e.target.value)}
              placeholder='{"version": 1, "skills": [...]}'
              className="font-mono text-xs min-h-[100px]"
            />

            {parseError && <p className="text-sm text-destructive">{parseError}</p>}

            {state.step === "preview" && (
              <div className="space-y-2">
                <p className="text-sm">
                  Found <strong>{state.bundle.skills.length}</strong> skill
                  {state.bundle.skills.length !== 1 ? "s" : ""}:
                </p>
                <div className="flex flex-wrap gap-1">
                  {state.bundle.skills.map((s) => (
                    <Badge key={s.name} variant="secondary">
                      {s.name}
                    </Badge>
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
