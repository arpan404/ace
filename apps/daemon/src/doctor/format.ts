/** `1.2 GB`, `684 KB`, `0 B`: binary units, one decimal from KB up. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** `5 worktrees`, `1 worktree`. */
export function plural(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

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

/** Keeps a check message within the report's 2,048-character limit. */
export function clip(text: string, limit = 2048): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
