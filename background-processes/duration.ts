/** Compact elapsed time, capped at days; optionally retain tenths below a minute. */
export function formatDuration(milliseconds: number, fractionalSeconds = false): string {
  const seconds = Math.max(0, milliseconds) / 1_000;
  const rounded = fractionalSeconds ? Number(seconds.toFixed(1)) : seconds;
  if (fractionalSeconds && rounded < 60) return `${rounded.toFixed(1)}s`;

  let remaining = Math.floor(rounded);
  const parts: string[] = [];
  for (const [unit, size] of [["d", 86_400], ["h", 3_600], ["m", 60], ["s", 1]] as const) {
    const value = Math.floor(remaining / size);
    if (value > 0) parts.push(`${value}${unit}`);
    remaining %= size;
  }
  return parts.join("") || "0s";
}
