import { contentHash, LruCache, readDiffText, type DiffText } from "@ace/ui-core";

/*
 * ```diff fences as `readDiffText` reads them (every line as written), cached by content, so a
 * fence that scrolls away and back, or shows in two places, is read once.
 */

const read = new LruCache<string, DiffText>({
  maxEntries: 128,
  maxWeight: 4 * 1024 * 1024,
  weigh: (diff) => diff.lines.reduce((sum, line) => sum + line.text.length * 2 + 48, 64),
});

/** A settled fence's diff. A fence still being written calls `readDiffText` directly. */
export function fenceDiffCached(code: string): DiffText {
  const key = contentHash(code);
  const cached = read.get(key);
  if (cached) return cached;
  const diff = readDiffText(code);
  read.set(key, diff);
  return diff;
}
