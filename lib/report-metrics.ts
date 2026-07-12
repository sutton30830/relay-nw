// Pure helpers for the reports page: the ratios and formatting that turn raw
// totals into the numbers an owner acts on. Kept dependency-free so the math is
// unit-testable in isolation.

// A rate in [0, 1], or null when there's nothing to divide by (so the UI can
// show "—" instead of a misleading 0% or a divide-by-zero).
export function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

export function formatPercent(value: number | null): string {
  if (value == null) return "—";
  return `${Math.round(value * 100)}%`;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Compact response-time label from seconds. Instant auto-texts land in seconds;
// slower manual follow-ups roll up to minutes/hours.
export function formatResponseTime(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 1) return "instant";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}
