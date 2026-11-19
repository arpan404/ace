import type { Command, HostId } from "@ace/protocol";
import type { ThreadInit } from "./daemon-options.ts";
import type { startedThread } from "./scenarios/started-thread.ts";
import { fakeCheckoutPath, type fakeWorktreeBase } from "./worktree-base.ts";

/*
 * The thread a `thread.prepare` or `thread.create` command makes: its id, title, access and the
 * details the list shows (checkout, branch, project, machine). Pure: the daemon checks the
 * command, builds the thread here, then creates and starts it.
 */

type Base = Extract<ReturnType<typeof fakeWorktreeBase>, { ok: true }>["fields"];

/** A prepared thread: set up and waiting for its first message. */
export function preparedThreadInit(
  payload: Extract<Command["payload"], { type: "thread.prepare" }>,
  base: Base,
): ThreadInit {
  return {
    id: payload.threadId,
    workspaceId: payload.workspaceId,
    title: payload.title,
    provider: payload.provider,
    ...(payload.access && payload.access !== "inherit" ? { access: payload.access } : {}),
    details: {
      mode: payload.mode ?? "local",
      worktree: fakeCheckoutPath(payload.mode, payload.threadId, payload.workspaceId),
      ...base,
    },
  };
}

/** A created thread, on this machine, in its project (a chat project shows as "Chat"). */
export function createdThreadInit(
  id: string,
  payload: Extract<Command["payload"], { type: "thread.create" }>,
  started: ReturnType<typeof startedThread>["thread"],
  base: Base,
  where: { chat: boolean; host: HostId; name: string },
): ThreadInit {
  return {
    ...started,
    ...(payload.access ? { access: payload.access } : {}),
    details: {
      workspace: {
        id: payload.workspaceId,
        name: payload.workspaceId,
        path: `/fake/${payload.workspaceId}`,
        ...(where.chat ? { kind: "chat" as const, name: "Chat" } : {}),
      },
      mode: payload.mode ?? "local",
      worktree: fakeCheckoutPath(payload.mode, id, payload.workspaceId),
      ...base,
      machine: { host: where.host, name: where.name },
      diff: { files: 0, additions: 0, deletions: 0 },
    },
    live: {
      ...(payload.model ? { model: payload.model } : {}),
      ...((payload.accountId ?? payload.account)
        ? { account: payload.accountId ?? payload.account }
        : {}),
      ...(payload.options ? { options: payload.options } : {}),
      subagentCount: 0,
      backgroundTaskCount: 0,
    },
  };
}
