"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { SkillParameter } from "@/lib/skill-schema";
import { skillParameterTypes } from "@/lib/skill-schema";

function stringifyDefault(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return `${value as string | number | boolean}`;
}

interface ParameterEditorProps {
  parameters: SkillParameter[];
  onChange: (parameters: SkillParameter[]) => void;
}

const emptyParam: SkillParameter = {
  name: "",
  type: "string",
  description: "",
  required: false,
};

export function ParameterEditor({ parameters, onChange }: ParameterEditorProps) {
  function updateParam(index: number, patch: Partial<SkillParameter>) {
    const updated = parameters.map((p, i) => (i === index ? { ...p, ...patch } : p));
    onChange(updated);
  }

  function removeParam(index: number) {
    onChange(parameters.filter((_, i) => i !== index));
  }

  function addParam() {
    onChange([...parameters, { ...emptyParam }]);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
          Parameters
        </Label>
        <Button type="button" variant="outline" size="xs" onClick={addParam}>
          <Plus className="h-3 w-3" />
          Add
        </Button>
      </div>

      {parameters.length === 0 && (
        <p className="text-xs text-muted-foreground/50">
          No parameters. This skill takes no input.
        </p>
      )}

      {parameters.map((param, i) => (
        <div
          key={i}
          className="grid grid-cols-[1fr_100px_1fr_auto_auto] items-end gap-2 rounded-lg border border-border/60 p-3"
        >
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground/60">Name</Label>
            <Input
              value={param.name}
              onChange={(e) => updateParam(i, { name: e.target.value })}
              placeholder="param-name"
              className="h-8 font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground/60">Type</Label>
            <Select
              value={param.type}
              onChange={(e) =>
                updateParam(i, {
                  type: e.target.value as SkillParameter["type"],
                  default: undefined,
                })
              }
              className="h-8 text-xs"
            >
              {skillParameterTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground/60">Description</Label>
            <Input
              value={param.description}
              onChange={(e) => updateParam(i, { description: e.target.value })}
              placeholder="What this param does"
              className="h-8 text-xs"
            />
          </div>
          <div className="flex flex-col items-center gap-1">
            <Label className="text-[10px] text-muted-foreground/60">Required</Label>
            <Switch
              checked={param.required}
              onCheckedChange={(checked) => updateParam(i, { required: !!checked })}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => removeParam(i)}
            className="text-muted-foreground/30 hover:text-destructive-foreground"
          >
            <Trash2 className="h-3 w-3" />
          </Button>

          {/* Default value row */}
          {!param.required && (
            <div className="col-span-5 mt-1">
              <div className="flex items-center gap-2">
                <Label className="shrink-0 text-[10px] text-muted-foreground/50">Default:</Label>
                {param.type === "boolean" ? (
                  <Select
                    value={param.default !== undefined ? stringifyDefault(param.default) : ""}
                    onChange={(e) =>
                      updateParam(i, {
                        default: e.target.value === "" ? undefined : e.target.value === "true",
                      })
                    }
                    className="h-7 w-28 text-xs"
                  >
                    <option value="">none</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </Select>
                ) : param.type === "array" || param.type === "object" ? (
                  <Input
                    value={param.default !== undefined ? JSON.stringify(param.default) : ""}
                    onChange={(e) => {
                      if (e.target.value === "") {
                        updateParam(i, { default: undefined });
                        return;
                      }
                      try {
                        updateParam(i, { default: JSON.parse(e.target.value) as unknown });
                      } catch {
                        // Allow typing — only persist valid JSON
                      }
                    }}
                    placeholder={param.type === "array" ? '["item1", "item2"]' : '{"key": "value"}'}
                    className="h-7 max-w-xs font-mono text-xs"
                  />
                ) : (
                  <Input
                    type={param.type === "number" ? "number" : "text"}
                    value={param.default !== undefined ? stringifyDefault(param.default) : ""}
                    onChange={(e) =>
                      updateParam(i, {
                        default:
                          e.target.value === ""
                            ? undefined
                            : param.type === "number"
                              ? Number(e.target.value)
                              : e.target.value,
                      })
                    }
                    placeholder="optional default"
                    className="h-7 max-w-xs text-xs"
                  />
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
