import {
  PluginReviewSummary,
  type PluginReview,
  type PluginReviewEntry,
} from "@ace/protocol/plugins";

export const reviewBytes = 256 * 1024;
export const pageBytes = 192 * 1024;
// Legacy source JSON could fill 256 KiB before import added names, defaults and wrappers.
// One complete entry may exceed the page target; this fixed ceiling includes that envelope
// and still leaves more than half of the daemon's 1 MiB message budget available.
const legacyEntryBytes = 384 * 1024;
/** Count JSON one scalar at a time, stopping before allocating a large serialized review. */
export function jsonSize(
  value: unknown,
  maximum: number,
  message = "Review exceeds byte limit",
): number {
  let bytes = 0;
  const add = (count: number) => {
    bytes += count;
    if (bytes > maximum) throw new Error(message);
  };
  function visit(entry: unknown): void {
    if (Array.isArray(entry)) {
      add(2 + Math.max(0, entry.length - 1));
      for (const item of entry) visit(item);
    } else if (entry !== null && typeof entry === "object") {
      add(2);
      let count = 0;
      for (const [key, item] of Object.entries(entry)) {
        if (item === undefined) continue;
        add(Buffer.byteLength(JSON.stringify(key)) + 1 + (count++ ? 1 : 0));
        visit(item);
      }
    } else {
      const json = JSON.stringify(entry);
      if (json === undefined) throw new Error("Invalid review JSON");
      add(Buffer.byteLength(json));
    }
  }
  visit(value);
  return bytes;
}
export function reviewSummary(review: PluginReview) {
  const { executions, unsupported, ...identity } = review;
  return PluginReviewSummary.parse({
    ...identity,
    executionCount: executions.length,
    unsupportedCount: unsupported.length,
  });
}
export function reviewPage(review: PluginReview, offset: number) {
  const total = review.executions.length + review.unsupported.length;
  if (offset > total) throw new Error("Invalid review offset");
  const entries: PluginReviewEntry[] = [];
  let bytes = 0;
  let cursor = offset;
  for (; cursor < total; cursor++) {
    const execution = review.executions[cursor];
    const diagnostic = review.unsupported[cursor - review.executions.length];
    const entry: PluginReviewEntry =
      execution === undefined
        ? { type: "diagnostic", message: diagnostic ?? "" }
        : { type: "execution", execution };
    const size = jsonSize(entry, legacyEntryBytes);
    if (bytes + size > pageBytes && entries.length) break;
    bytes += size;
    entries.push(entry);
  }
  return {
    type: "plugins.reviewPage",
    review: reviewSummary(review),
    entries,
    ...(cursor < total ? { nextOffset: cursor } : {}),
  };
}
