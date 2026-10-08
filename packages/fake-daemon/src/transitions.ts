import type { CommandPayload, EventPayload, ForkPoint } from "@ace/protocol";
import { busy } from "./thread-commands.ts";
import type { ThreadHost } from "./thread-host.ts";

/*
 * The fake daemon's forks and switches (ADR 0051). No provider session exists, so a fork is a
 * new thread that starts from its first message, and a switch applies once the root agent is
 * free, as the engine applies it at a quiescent boundary.
 */

/** Why a fork can't start at `point`, or undefined when it can: only finished turns fork. */
export function forkPointError(host: ThreadHost, point: ForkPoint): string | undefined {
  if (point.type === "turn") {
    const run = host.view.runs[point.runId];
    return run && run.state !== "active" ? undefined : "fork_point_unavailable";
  }
  const item = host.view.items[point.itemId];
  return item && (!("complete" in item) || item.complete) ? undefined : "fork_point_unavailable";
}

/** Apply a queued switch once nothing runs: the thread continues on the new selection. */
export function switchEvents(host: ThreadHost, at: number): EventPayload[] {
  const pending = host.view.thread.switch;
  if (pending?.state !== "queued" || busy(host)) return [];
  const { selection } = pending;
  if (host.queue.reason === "model_unavailable") {
    host.queue.paused = false;
    host.queue.reason = null;
    host.queueDirty = true;
  }
  return [
    {
      type: "thread.updated",
      provider: selection.provider,
      execution: selection,
      switch: { ...pending, state: "applied", at },
    },
    {
      type: "thread.client.updated",
      changes: {
        live: {
          ...host.view.thread.live,
          provider: selection.provider,
          ...(selection.model ? { model: selection.model } : {}),
          ...(selection.instanceId ? { account: selection.instanceId } : {}),
          ...(Object.keys(selection.options).length
            ? { options: { ...host.view.thread.live?.options, ...selection.options } }
            : {}),
        },
      },
    },
  ];
}

/** The fake publishes the same synthetic context message as a completed real merge. */
export function mergeForkError(
  fork: ThreadHost,
  parent: ThreadHost | undefined,
  payload: Extract<CommandPayload, { type: "thread.merge" }>,
): string | undefined {
  if (!fork.view.thread.lineage) return "thread_is_not_a_fork";
  if (!parent || parent.view.thread.deletedAt !== undefined) return "source_thread_not_found";
  if (busy(fork) || fork.queued.length) return "fork_tree_is_live";
  if (payload.patch && (busy(parent) || parent.queued.length)) return "source_tree_is_live";
  if (
    !payload.citations.every(
      (citation) => citation.threadId === fork.id && fork.view.items[citation.itemId],
    )
  )
    return "invalid_citation_thread";
  return undefined;
}
