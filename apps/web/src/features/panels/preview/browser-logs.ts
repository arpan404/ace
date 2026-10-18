import { z } from "zod";
import type { BrowserLogEntry } from "../sources.ts";

const Entry = z.object({
  kind: z.enum(["console", "network"]),
  type: z.string().max(64),
  text: z.string().max(8192),
  at: z.number().finite(),
  tabId: z.string().optional(),
  requestId: z.string().optional(),
  url: z.string().max(8192).optional(),
  status: z.number().int().optional(),
  method: z.string().max(32).optional(),
  bytes: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
});

/**
 * A `logs` result as the console drawer reads it. Lenient: an entry this client can't read is
 * skipped, never the whole log.
 */
export function readBrowserLogs(result: unknown): readonly BrowserLogEntry[] {
  const parsed = z.object({ entries: z.array(z.unknown()).max(1000) }).safeParse(result);
  if (!parsed.success) return [];
  const entries: BrowserLogEntry[] = [];
  for (const raw of parsed.data.entries) {
    const entry = Entry.safeParse(raw);
    if (entry.success) entries.push(entry.data);
  }
  return entries;
}
