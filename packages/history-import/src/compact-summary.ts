import { object, string } from "@ace/native-session";

/** Records up to this size travel inline as raw data; larger ones go to blobs. */
export const inlineRawBytes = 60 * 1024;

/** A summary found for a compaction: its text and, when small enough, its record. */
export interface CompactSummary {
  text: string;
  /** The summary's own record, to keep raw on the compaction; absent when it is a blob. */
  data?: unknown;
}

/**
 * The text of a Claude transcript's compaction summary (`isCompactSummary`) and the boundary
 * it continues (its `parentUuid`), or undefined for any other record. Pure.
 */
export function compactSummaryOf(value: unknown): { boundary: string; text: string } | undefined {
  const r = object(value);
  if (r.type !== "user" || r.isCompactSummary !== true) return undefined;
  const boundary = string(r.parentUuid);
  const content = object(r.message).content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map(object)
            .flatMap((block) => (block.type === "text" ? [string(block.text) ?? ""] : []))
            .join("")
        : "";
  return boundary && text ? { boundary, text } : undefined;
}
