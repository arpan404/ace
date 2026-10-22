import { z } from "zod";

export type LogDigest = {
  level: "error" | "warn";
  component: string;
  message: string;
  count: number;
  lastAt: number;
  /** The newest entry's data, shortened. */
  sample?: string;
};

const Record = z.object({
  at: z.number(),
  level: z.string(),
  component: z.string().catch("ace"),
  message: z.string(),
  data: z.unknown().optional(),
});

/**
 * Groups recent warnings and errors so a handoff shows "40× X" once instead of 40 lines.
 * Malformed lines, other levels and anything older than the window are skipped.
 */
export function digestLogLines(
  lines: Iterable<string>,
  options: { now: number; windowMs?: number; limit?: number },
): LogDigest[] {
  const since = options.now - (options.windowMs ?? 86_400_000);
  const groups = new Map<string, LogDigest>();
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = Record.safeParse(parsed);
    if (!record.success) continue;
    const { at, level, component, message, data } = record.data;
    if ((level !== "error" && level !== "warn") || at < since || at > options.now + 60_000)
      continue;
    const key = `${level}\u0000${component}\u0000${message}`;
    const existing = groups.get(key);
    const sample = data === undefined ? undefined : shorten(JSON.stringify(data) ?? "");
    if (existing) {
      existing.count += 1;
      if (at >= existing.lastAt) {
        existing.lastAt = at;
        if (sample) existing.sample = sample;
      }
    } else
      groups.set(key, {
        level,
        component: shorten(component, 60),
        message: shorten(message, 200),
        count: 1,
        lastAt: at,
        ...(sample ? { sample } : {}),
      });
  }
  return [...groups.values()]
    .toSorted(
      (a, b) =>
        (a.level === b.level ? 0 : a.level === "error" ? -1 : 1) ||
        b.count - a.count ||
        b.lastAt - a.lastAt,
    )
    .slice(0, options.limit ?? 12);
}

function shorten(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
