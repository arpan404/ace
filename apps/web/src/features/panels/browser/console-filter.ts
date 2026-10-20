import type { BrowserLogEntry } from "../sources.ts";

/** The console drawer's level filter: errors, warnings, the rest, or everything. */
export type ConsoleLevel = "all" | "error" | "warning" | "info";
/** The network list's filter: every request, or only the failed ones. */
export type NetworkFilter = "all" | "failed";

/** Which bucket a console entry's level falls in. Uncaught errors and asserts are errors. */
export function consoleLevel(type: string): Exclude<ConsoleLevel, "all"> {
  if (type === "error" || type === "pageerror" || type === "assert") return "error";
  if (type === "warning" || type === "warn" || type === "permission.denied") return "warning";
  return "info";
}

/** A request that did not succeed: it failed to load or its server answered 400 or above. */
export function requestFailed(entry: BrowserLogEntry): boolean {
  return entry.type === "failed" || (entry.status !== undefined && entry.status >= 400);
}

/**
 * The entries the drawer lists for one section: those of its kind recorded after the person's
 * last Clear (`clearedAt`), narrowed by the section's filter. Order is kept (oldest first).
 */
export function visibleEntries(
  entries: readonly BrowserLogEntry[],
  view:
    | { kind: "console"; level: ConsoleLevel; clearedAt: number | undefined }
    | { kind: "network"; filter: NetworkFilter; clearedAt: number | undefined },
): readonly BrowserLogEntry[] {
  return entries.filter((entry) => {
    if (entry.kind !== view.kind) return false;
    if (view.clearedAt !== undefined && entry.at <= view.clearedAt) return false;
    if (view.kind === "console")
      return view.level === "all" || consoleLevel(entry.type) === view.level;
    return view.filter === "all" || requestFailed(entry);
  });
}

/** `1.2 kB`, `340 B`, `2.4 MB`: a response's size in a column. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** `84 ms`, `1.3 s`: how long a request took. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** A stable key per entry for a list: when it was logged and what it says, counted on repeats. */
export function entryKeys(entries: readonly BrowserLogEntry[]): readonly string[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const base = `${entry.at}\u0000${entry.requestId ?? entry.text}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return `${base}\u0000${count}`;
  });
}
