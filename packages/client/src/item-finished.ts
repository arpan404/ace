/**
 * Whether a transcript item is finished: no longer streaming, and not a tool call still waiting
 * or running. A finished item never changes again, so it is merged by sequence on resume
 * (ADR 0062) and kept on disk once (ADR 0105). Lenient: it reads an item from disk as readily as
 * one from the store, and anything it cannot read is unfinished.
 */
export function itemFinished(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  if (!("complete" in item) || item.complete !== true) return false;
  if (!("type" in item) || item.type !== "tool_call") return true;
  const call = "call" in item ? item.call : undefined;
  if (typeof call !== "object" || call === null || !("status" in call)) return false;
  return !unfinishedCalls.has(String(call.status));
}

const unfinishedCalls = new Set(["pending", "awaiting_approval", "running"]);
