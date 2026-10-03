import type { ThreadId } from "@ace/protocol";

interface AncestorState {
  parentId?: ThreadId;
  stopped: boolean;
}

/** Inspect ancestors only: an explicit send may reopen its own settled stop marker. */
export function hasStoppedAncestor(
  thread: ThreadId,
  read: (thread: ThreadId) => AncestorState,
): boolean {
  let parent = read(thread).parentId;
  // The protocol's hard maximum is eight edges. Fail closed on malformed lineage.
  for (let depth = 0; parent !== undefined && depth < 8; depth++) {
    const state = read(parent);
    if (state.stopped) return true;
    parent = state.parentId;
  }
  return parent !== undefined;
}
