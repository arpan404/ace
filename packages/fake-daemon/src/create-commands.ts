import type { Fact } from "@ace/core";
import {
  ThreadId,
  type Command,
  type CommandPayload,
  type CommandResult,
  type HostId,
} from "@ace/protocol";
import type { FakeContextWire } from "./context-wire.ts";
import { createdThreadInit, preparedThreadInit } from "./created-threads.ts";
import type { ThreadInit } from "./daemon-options.ts";
import { completedThread, startedThread } from "./scenarios/started-thread.ts";
import type { ThreadHost } from "./thread-host.ts";
import { fakeWorktreeBase } from "./worktree-base.ts";

/*
 * The fake daemon's `thread.prepare` and `thread.create` commands: the thread each makes comes
 * from `created-threads.ts`; this module checks the command, then creates and starts it through
 * the daemon's own thread store.
 */

/** What the create commands reach of the fake daemon. */
export interface CreateCommandHost {
  threads: ReadonlyMap<string, ThreadHost>;
  context: Pick<FakeContextWire, "validateDraft" | "adopt" | "messageAttachments">;
  readonly remoteReachable: boolean;
  readonly hostId: HostId;
  readonly displayName: string;
  /** Whether the workspace is a chat's hidden project. */
  isChat(workspaceId: string): boolean;
  /** Runs a fixture completion later, when the daemon was given a schedule for one. */
  scheduleCompletion?: (run: () => void) => void;
  createThread(init: ThreadInit): void;
  apply(threadId: string, facts: readonly Fact[]): void;
}

type PreparePayload = Extract<CommandPayload, { type: "thread.prepare" }>;
type CreatePayload = Extract<CommandPayload, { type: "thread.create" }>;

/** Make a prepared thread: set up and waiting for its first message. */
export function prepareThread(
  host: CreateCommandHost,
  payload: PreparePayload,
  commandId: Command["id"],
): CommandResult {
  if (host.threads.has(payload.threadId)) return { commandId, ok: false, error: "thread_exists" };
  const base = fakeWorktreeBase(payload, payload.title, host.remoteReachable);
  if (!base.ok) return { commandId, ok: false, error: base.error };
  host.createThread(preparedThreadInit(payload, base.fields));
  return { commandId, ok: true, threadId: payload.threadId };
}

/** Make a thread and start its first run. Running it again for the same command is a no-op. */
export function createThread(
  host: CreateCommandHost,
  payload: CreatePayload,
  command: Command,
): CommandResult {
  const commandId = command.id;
  // No provider is contacted; the host may schedule a fixture completion.
  const id = payload.threadId ?? `thread-${commandId}`;
  if (host.threads.has(id)) return { commandId, ok: true, threadId: ThreadId.parse(id) };
  const started = startedThread(id, payload, commandId);
  const base = fakeWorktreeBase(payload, started.thread.title, host.remoteReachable);
  if (!base.ok) return { commandId, ok: false, error: base.error };
  if (payload.context?.draftId)
    host.context.validateDraft(command.deviceId, payload.context.draftId, payload.workspaceId, id);
  host.createThread(
    createdThreadInit(id, payload, started.thread, base.fields, {
      chat: host.isChat(payload.workspaceId),
      host: host.hostId,
      name: host.displayName,
    }),
  );
  if (payload.context?.draftId) host.context.adopt(command.deviceId, payload.context.draftId, id);
  const attachments = host.context.messageAttachments(
    id,
    payload.context?.attachments.map((a) => a.sha256) ?? [],
  );
  for (const fact of started.facts)
    if (
      fact.type === "item.upsert" &&
      fact.draft.type === "message" &&
      fact.draft.role === "user" &&
      attachments.length
    )
      fact.draft.attachments = attachments;
  host.apply(id, started.facts);
  const runId = host.threads.get(id)?.state.agents.root?.activeRun;
  host.scheduleCompletion?.(() => {
    const created = host.threads.get(id);
    if (runId && created?.state.agents.root?.activeRun === runId)
      host.apply(id, completedThread(commandId));
  });
  return { commandId, ok: true, threadId: ThreadId.parse(id) };
}
