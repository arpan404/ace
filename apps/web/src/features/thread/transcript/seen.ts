import { z } from "zod";
import { readJson, writeJson, type KeyValueStorage } from "@/lib/storage.ts";

/**
 * Where the reader left each thread: the newest item they had on screen. The "New activity"
 * divider goes before the first block after it. Kept on this device only.
 */
const Seen = z.record(z.string(), z.string());
const key = "ace.thread.seen";
const limit = 200;

function storage(): KeyValueStorage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export function lastSeen(threadId: string): string | undefined {
  return readJson(storage(), key, Seen, {})[threadId];
}

export function markSeen(threadId: string, itemId: string): void {
  const all = readJson(storage(), key, Seen, {});
  delete all[threadId];
  all[threadId] = itemId;
  // Oldest entries go first, so the record stays small.
  const entries = Object.entries(all).slice(-limit);
  writeJson(storage(), key, Object.fromEntries(entries));
}
