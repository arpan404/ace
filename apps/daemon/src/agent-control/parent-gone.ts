import type { Thread, ThreadId } from "@ace/protocol";

/**
 * A parent nothing can report to any more: its thread was deleted, or the engine holds no state
 * for it (its data was purged). A child's edge to such a parent is settled or dropped, and never
 * applied to it in the engine. Without an engine, only the deletion is known.
 */
export function parentGone(
  thread: (id: ThreadId) => Pick<Thread, "deletedAt"> | undefined,
  engine: { hasState(id: ThreadId): boolean } | undefined,
  id: ThreadId,
): boolean {
  if (thread(id)?.deletedAt !== undefined) return true;
  return engine !== undefined && !engine.hasState(id);
}
