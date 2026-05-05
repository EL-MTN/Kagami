interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
  filled?: boolean;
  baseline?: number;
  domain?: [number, number];
  showLast?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function Sparkline({
  values,
  width = 120,
  height = 32,
  stroke = "currentColor",
  filled = true,
  baseline,
  domain,
  showLast = true,
  className,
  ariaLabel,
}: SparklineProps) {
  if (values.length === 0) {
    return <div style={{ width, height }} className={className} aria-hidden />;
  }

  const [domainMin, domainMax] = domain ?? [Math.min(...values), Math.max(...values)];
  const range = domainMax - domainMin || 1;
  const padX = 1.5;
  const padY = 2;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const xAt = (i: number) =>
    values.length === 1 ? width / 2 : padX + (i / (values.length - 1)) * innerW;
  const yAt = (v: number) => padY + innerH - ((v - domainMin) / range) * innerH;

  const points = values.map((v, i) => `${xAt(i).toFixed(2)},${yAt(v).toFixed(2)}`);
  const linePath = `M${points.join(" L")}`;
  const areaPath =
    values.length > 1
      ? `${linePath} L${xAt(values.length - 1).toFixed(2)},${(height - padY).toFixed(2)} L${padX.toFixed(2)},${(height - padY).toFixed(2)} Z`
      : "";

  const lastX = xAt(values.length - 1);
  const lastY = yAt(values[values.length - 1]);
  const baselineY = baseline !== undefined ? yAt(baseline) : null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      className={className}
      style={{ color: stroke }}
    >
      {baselineY !== null && (
        <line
          x1={padX}
          y1={baselineY}
          x2={width - padX}
          y2={baselineY}
          stroke="var(--color-border)"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      )}
      {filled && areaPath && (
        <path d={areaPath} fill="currentColor" fillOpacity={0.08} stroke="none" />
      )}
      <path
        d={linePath}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {showLast && (
        <circle
          cx={lastX}
          cy={lastY}
          r={2.25}
          fill="var(--color-card)"
          stroke="currentColor"
          strokeWidth={1.5}
        />
      )}
    </svg>
  );
}
