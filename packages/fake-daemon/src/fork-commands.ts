import type { Fact } from "@ace/core";
import { ThreadId, type Command, type CommandPayload, type CommandResult } from "@ace/protocol";
import type { FakeContextWire } from "./context-wire.ts";
import type { ThreadInit } from "./daemon-options.ts";
import { startedThread } from "./scenarios/started-thread.ts";
import type { ThreadHost } from "./thread-host.ts";
import { forkOpening, forkPointError, mergeFacts, mergeForkError } from "./transitions.ts";

/*
 * The fake daemon's `thread.fork` and `thread.merge` commands (ADR 0051): a fork is a new thread
 * opening at the source's point, its first message carrying the files the source holds, and a
 * merge brings a fork's result back into its parent. The rules are `transitions.ts`'s; this
 * module applies them through the daemon's own thread store.
 */

/** What the fork commands reach of the fake daemon. */
export interface ForkCommandHost {
  threads: ReadonlyMap<string, ThreadHost>;
  context: Pick<FakeContextWire, "messageAttachments" | "inherit">;
  createThread(init: ThreadInit): void;
  apply(threadId: string, facts: readonly Fact[]): void;
}

type ForkPayload = Extract<CommandPayload, { type: "thread.fork" }>;
type MergePayload = Extract<CommandPayload, { type: "thread.merge" }>;

/** Fork `payload.threadId` at its point. Running it again for the same command is a no-op. */
export function forkThread(
  host: ForkCommandHost,
  payload: ForkPayload,
  commandId: Command["id"],
): CommandResult {
  const source = host.threads.get(payload.threadId);
  if (!source || source.view.thread.deletedAt !== undefined)
    return { commandId, ok: false, error: "thread_not_found" };
  const refused = forkPointError(source, payload.point);
  if (refused) return { commandId, ok: false, error: refused };
  // The first message carries files the source holds, as the daemon gives the fork its own.
  const attachments = host.context.messageAttachments(
    payload.threadId,
    payload.context?.attachments.map((a) => a.sha256) ?? [],
  );
  const id = `${payload.threadId}-fork-${commandId}`;
  if (host.threads.has(id)) return { commandId, ok: true, forkThreadId: ThreadId.parse(id) };
  const from = source.view.thread;
  const provider = payload.selection?.provider ?? from.provider;
  const started = startedThread(id, {
    type: "thread.create",
    workspaceId: from.workspaceId,
    provider,
    ...(payload.selection?.model ? { model: payload.selection.model } : {}),
    title: payload.title ?? `${from.title} (fork)`,
    input: [{ type: "text", text: payload.input }],
  });
  const opening = forkOpening(source, payload.point, provider);
  host.createThread({
    ...started.thread,
    ...(from.details ? { details: from.details } : {}),
    execution: payload.selection ?? { provider, options: {} },
    lineage: opening.lineage,
  });
  if (attachments.length)
    host.context.inherit(
      payload.threadId,
      id,
      attachments.map((attachment) => attachment.sha256),
    );
  for (const fact of started.facts)
    if (
      fact.type === "item.upsert" &&
      fact.draft.type === "message" &&
      fact.draft.role === "user" &&
      attachments.length
    )
      fact.draft.attachments = attachments;
  const [root, ...rest] = started.facts;
  host.apply(id, [...(root ? [root] : []), ...opening.facts, ...rest]);
  return { commandId, ok: true, forkThreadId: ThreadId.parse(id) };
}

/** Merge the fork `payload.threadId` back into the thread it was forked from. */
export function mergeFork(
  host: ForkCommandHost,
  payload: MergePayload,
  commandId: Command["id"],
): CommandResult {
  const fork = host.threads.get(payload.threadId);
  if (!fork) return { commandId, ok: false, error: "thread_not_found" };
  const parent = host.threads.get(fork.view.thread.lineage?.parentThreadId ?? "");
  const error = mergeForkError(fork, parent, payload);
  if (error || !parent) return { commandId, ok: false, error: error ?? "source_thread_not_found" };
  host.apply(parent.id, mergeFacts(payload, commandId));
  return { commandId, ok: true };
}
