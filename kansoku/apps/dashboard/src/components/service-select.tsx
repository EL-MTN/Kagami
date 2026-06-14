import { cn } from "@/lib/utils";

interface ServiceSelectProps {
  services: string[];
  name?: string;
  defaultValue?: string;
  value?: string;
  onChange?: (v: string) => void;
  className?: string;
}

/**
 * Shared presentational <select> for picking a service. Works both as an
 * uncontrolled native form field (server forms pass `name` + `defaultValue`)
 * and as a controlled input (clients pass `value` + `onChange`). The first
 * option is "any" with an empty value, matching the rest of the dashboard's
 * "empty string means unfiltered" convention.
 */
export function ServiceSelect({
  services,
  name,
  defaultValue,
  value,
  onChange,
  className,
}: ServiceSelectProps) {
  // A select is "controlled" only when a `value` prop is present. Mixing a
  // controlled `value` with a `defaultValue` is a React error, so forward
  // `defaultValue` only in the uncontrolled case.
  const controlled = value !== undefined;

  return (
    <select
      name={name}
      {...(controlled ? { value } : { defaultValue })}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      className={cn(
        "rounded-md border border-input bg-background px-3 py-1.5 font-mono text-sm text-foreground focus:border-primary focus:outline-none",
        className,
      )}
    >
      <option value="">any</option>
      {services.map((service) => (
        <option key={service} value={service}>
          {service}
        </option>
      ))}
    </select>
  );
}
