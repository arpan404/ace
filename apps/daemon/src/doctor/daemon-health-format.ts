/** A duration as a person reads it: "40 s", "12 min", "5 h", "3 days". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export function megabytes(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function milliseconds(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value.toFixed(1)} ms`;
}

/** Check messages are capped at 2048 characters. */
export function clip(text: string): string {
  return text.length > 2048 ? `${text.slice(0, 2047)}…` : text;
}
