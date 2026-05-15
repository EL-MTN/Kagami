interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
  ariaLabel?: string;
}

/**
 * Inline SVG line chart. Renders a polyline through `values`, normalized to
 * the [0, max(values)] range. Zero-padded inputs render as a flat baseline.
 * Stroke uses `currentColor`, so the caller can theme it via Tailwind.
 */
export function Sparkline({
  values,
  width = 160,
  height = 32,
  className,
  ariaLabel,
}: SparklineProps) {
  if (values.length === 0) {
    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className={className}
        aria-label={ariaLabel}
      />
    );
  }

  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = height - (v / max) * (height - 2) - 1;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      aria-label={ariaLabel}
      role={ariaLabel ? "img" : undefined}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
