import type { Fact } from "@ace/core";
import { inheritedDrafts } from "@ace/handoff";
import {
  AgentId,
  type CommandPayload,
  type EventPayload,
  type ForkPoint,
  type Item,
  type ThreadLineage,
} from "@ace/protocol";
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

/** The agent whose conversation a fork at `point` continues: the turn's or the answer's. */
function forkedAgent(host: ThreadHost, point: ForkPoint): string {
  const owner =
    point.type === "turn"
      ? host.view.runs[point.runId]?.agentId
      : host.view.items[point.itemId]?.agentId;
  return owner ?? host.view.thread.rootAgentId ?? "";
}

/**
 * A fork's lineage and the copies it opens on, as the daemon makes them: the forked agent's
 * asks and answers through the fork point (`@ace/handoff`'s drafts), to apply after the fork's
 * root agent and before its first message.
 */
export function forkOpening(
  host: ThreadHost,
  point: ForkPoint,
  provider: string,
): { lineage: ThreadLineage; facts: Fact[] } {
  const items = Object.values(host.view.items).toSorted(
    (a: Item, b: Item) => a.createdAt - b.createdAt,
  );
  const end = items.findLastIndex((item) =>
    point.type === "turn" ? item.runId === point.runId : item.id === point.itemId,
  );
  const agentId = forkedAgent(host, point);
  const from = host.view.thread;
  return {
    lineage: {
      parentThreadId: from.id,
      parentAgentId: AgentId.parse(agentId || `${from.id}.root`),
      point,
      mode: provider === from.provider ? "native" : "portable",
      lossy: provider !== from.provider,
    },
    facts: inheritedDrafts(items.slice(0, end + 1), agentId, from.id).map(({ key, draft }) => ({
      type: "item.upsert",
      agent: "root",
      item: key,
      draft,
    })),
  };
}

/** Publish a selection split off a steer, then apply a queued switch once nothing runs. */
export function switchEvents(host: ThreadHost, at: number): EventPayload[] {
  const split = host.steerSwitch;
  host.steerSwitch = undefined;
  const queued = split && { selection: split, state: "queued" as const, lossy: false, at };
  const published: EventPayload[] = queued ? [{ type: "thread.updated", switch: queued }] : [];
  const pending = queued ?? host.view.thread.switch;
  if (pending?.state !== "queued" || busy(host)) return published;
  const { selection } = pending;
  if (host.queue.reason === "model_unavailable") {
    host.queue.paused = false;
    host.queue.reason = null;
    host.queueDirty = true;
  }
  return [
    ...published,
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

/** Why a fork can't merge back into its parent yet, or undefined when it can. */
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

/** The fake publishes the same synthetic context message as a completed real merge. */
export function mergeFacts(
  payload: Extract<CommandPayload, { type: "thread.merge" }>,
  commandId: string,
): Fact[] {
  return [
    {
      type: "item.upsert",
      agent: "root",
      item: `merge:${commandId}`,
      draft: {
        type: "message",
        role: "user",
        synthetic: true,
        complete: true,
        mergedContext: {
          sourceThreadId: payload.threadId,
          summary: payload.summary,
          citations: payload.citations,
          patchApplied: payload.patch !== undefined,
        },
        parts: [{ type: "text", text: payload.summary }],
      },
    },
  ];
}
