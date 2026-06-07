"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ListFieldProps {
  id: string;
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
}

export function ListField({ id, label, values, onChange, placeholder }: ListFieldProps) {
  function updateAt(index: number, value: string) {
    onChange(values.map((item, i) => (i === index ? value : item)));
  }

  function removeAt(index: number) {
    onChange(values.filter((_, i) => i !== index));
  }

  function add() {
    onChange([...values, ""]);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label
          htmlFor={id}
          className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground"
        >
          {label}
        </Label>
        <Button type="button" variant="ghost" size="xs" onClick={add}>
          Add
        </Button>
      </div>
      <div className="space-y-2">
        {values.length === 0 ? (
          <p className="text-xs text-faint">None</p>
        ) : (
          values.map((value, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                id={index === 0 ? id : undefined}
                value={value}
                onChange={(event) => updateAt(index, event.target.value)}
                placeholder={placeholder}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-faint hover:text-destructive-foreground"
                onClick={() => removeAt(index)}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
