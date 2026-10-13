import { useInteractions, useThread, useThreadMeta } from "@ace/client-react";
import type { ThreadReader } from "@ace/client";
import type { Interaction } from "@ace/protocol";
import { useCallback } from "react";

/**
 * A request waiting on the person in a delegated child thread (or further down its tree),
 * answered from the parent's strip. `interactionId` is the child's open request when it can be
 * answered here; without one (not loaded yet, another device's thread, or a request with no
 * choices to offer) the strip says who needs the person and opens the child instead.
 */
export interface DescendantRequest {
  /** The thread that holds the request. */
  threadId: string;
  /** What the parent calls the child that asks: "general assistant". */
  name: string;
  interactionId: string | undefined;
  /** What it asks for (an interaction kind), once the child's request is loaded. */
  kind: Interaction["request"]["kind"] | undefined;
}

/** A delegated child the thread waits on, from the daemon's live hints. */
function useAskingChild(threadId: string | undefined) {
  const child = useThreadMeta(threadId)?.live?.askingThreads?.[0];
  return child ? { id: child.id, name: child.name ?? "Subagent" } : undefined;
}

/** A request the person can answer in place: an approval needs choices to offer. */
const answerable = (interaction: Interaction) =>
  interaction.state === "pending" &&
  (interaction.request.kind !== "approval" || interaction.request.options.length > 0);

const kindOf = (reader: ThreadReader, id: string | undefined) =>
  id ? reader.interaction(id)?.request.kind : undefined;

/** The first answerable open request in `threadId`, with what it asks for. */
function useOpenRequest(threadId: string | undefined) {
  const ids = useInteractions(threadId, answerable);
  const id = ids?.[0];
  const read = useCallback((reader: ThreadReader) => kindOf(reader, id), [id]);
  const kind = useThread(threadId, id ? [`interaction:${id}`] : [], read);
  return id ? { id, kind } : undefined;
}

/**
 * The oldest request a delegated child (or its child, or theirs) waits on the person for, while
 * the thread itself has none of its own to show first. Follows the daemon's `askingThreads`
 * hints three levels down; deeper trees open the deepest known child.
 */
export function useDescendantRequest(threadId: string): DescendantRequest | undefined {
  const child = useAskingChild(threadId);
  const childRequest = useOpenRequest(child?.id);
  const grandchild = useAskingChild(childRequest ? undefined : child?.id);
  const grandchildRequest = useOpenRequest(grandchild?.id);
  const great = useAskingChild(grandchildRequest ? undefined : grandchild?.id);
  const greatRequest = useOpenRequest(great?.id);
  const levels = [
    [child, childRequest],
    [grandchild, grandchildRequest],
    [great, greatRequest],
  ] as const;
  let deepest: DescendantRequest | undefined;
  for (const [asker, request] of levels) {
    if (!asker) break;
    deepest = {
      threadId: asker.id,
      name: asker.name,
      interactionId: request?.id,
      kind: request?.kind,
    };
    if (request) return deepest;
  }
  return deepest;
}
