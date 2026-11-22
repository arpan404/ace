import type { Command, CommandResult, ThreadId } from "@ace/protocol";
import type { Store } from "./store.ts";
import { recoveryHeld } from "./thread-move.ts";
import { threadHasPendingWork } from "./thread-organization.ts";
import type { WorkspaceGit } from "./workspace-roots.ts";

export type SourceControlCommandPayload = Extract<
  Command["payload"],
  {
    type:
      | "git.stage"
      | "git.unstage"
      | "git.discard"
      | "git.branch.switch"
      | "git.branch.create"
      | "git.pull"
      | "git.fetch"
      | "git.stash.push"
      | "git.stash.pop";
  }
>;

const sourceControlTypes = new Set<string>([
  "git.stage",
  "git.unstage",
  "git.discard",
  "git.branch.switch",
  "git.branch.create",
  "git.pull",
  "git.fetch",
  "git.stash.push",
  "git.stash.pop",
]);

export function isSourceControlCommand(
  payload: Command["payload"],
): payload is SourceControlCommandPayload {
  return sourceControlTypes.has(payload.type);
}

/**
 * Whether the thread's agent may be writing to its checkout: a turn is running or waiting on
 * the person, an intent is pending, or provider background work still runs (ADR 0116). A paused
 * recovery hold runs nothing until Continue, so it is not live. Switching branches, pulling or
 * stashing underneath a live agent changes the files it is editing.
 */
export function isThreadAgentBusy(
  store: Store,
  threadId: ThreadId,
  runsProviderWork: (id: ThreadId) => boolean,
): boolean {
  const thread = store.getThread(threadId);
  if (!thread) return false;
  if (recoveryHeld(store, thread)) return false;
  if (runsProviderWork(threadId)) return true;
  if (threadHasPendingWork(store, threadId, () => false)) return true;
  const state = thread.status.state;
  return state === "working" || state === "needs_you" || state === "waiting";
}

/** Commands that rewrite files in the checkout: each holds the whole checkout while it runs. */
const rewritesFiles = new Set<string>([
  "git.discard",
  "git.branch.switch",
  "git.branch.create",
  "git.pull",
  "git.stash.push",
  "git.stash.pop",
]);

/** Hold refusals the person can act on, returned as words rather than thrown. */
const refusals = new Set(["agent_working", "workspace_change_in_progress"]);

export interface SourceControlCommandContext {
  git: WorkspaceGit;
  store: Store;
  threadId: ThreadId;
  commandId: string;
  cwd: string;
  runsProviderWork: (id: ThreadId) => boolean;
  trashFile?:
    | ((threadId: ThreadId, root: string, path: string, fingerprint: string) => Promise<void>)
    | undefined;
  /**
   * The engine's checkout hold: every thread bound to the checkout must be quiet and none may
   * start until the change finishes. Without an engine only this thread's busy check applies.
   */
  holdCheckout?:
    | (<T>(commandId: string, top: string, effect: () => Promise<T>) => Promise<T>)
    | undefined;
  refreshDetails: () => Promise<void>;
}

/** Execute one thread-scoped source control command, refreshing details afterwards. */
export async function runSourceControlCommand(
  context: SourceControlCommandContext,
  payload: SourceControlCommandPayload,
): Promise<Omit<CommandResult, "commandId">> {
  const { store, threadId, cwd, runsProviderWork, holdCheckout } = context;
  const refresh = () => context.refreshDetails().catch(() => {});
  try {
    if (!rewritesFiles.has(payload.type)) await apply(context, payload);
    else if (holdCheckout)
      // The whole Git worktree, whichever folder of it the thread runs in.
      await holdCheckout(context.commandId, await context.git.worktreeTop(cwd), () =>
        apply(context, payload),
      );
    else if (isThreadAgentBusy(store, threadId, runsProviderWork))
      return { ok: false, error: "agent_working" };
    else await apply(context, payload);
  } catch (error) {
    if (error instanceof Error && refusals.has(error.message))
      return { ok: false, error: error.message };
    // A failed change may still have moved files or refs: show what is there now.
    await refresh();
    throw error;
  }
  await refresh();
  return { ok: true };
}

async function apply(
  context: SourceControlCommandContext,
  payload: SourceControlCommandPayload,
): Promise<void> {
  const { git, threadId, cwd, trashFile } = context;
  switch (payload.type) {
    case "git.stage":
      return git.stage({ worktree: cwd, paths: payload.paths });
    case "git.unstage":
      return git.unstage({ worktree: cwd, paths: payload.paths });
    case "git.discard":
      return git.discard({
        worktree: cwd,
        files: payload.files,
        ...(trashFile
          ? { trash: (root, path, fingerprint) => trashFile(threadId, root, path, fingerprint) }
          : {}),
      });
    case "git.branch.switch":
      return git.switchBranch({
        worktree: cwd,
        branch: payload.branch,
        remote: payload.remote,
        allowUncommitted: true,
      });
    case "git.branch.create":
      return git.createBranch({ worktree: cwd, branch: payload.branch });
    case "git.pull":
      return git.pull({ worktree: cwd, remote: payload.remote });
    case "git.fetch":
      return git.fetch({ worktree: cwd, remote: payload.remote });
    case "git.stash.push":
      return git.stashPush({
        worktree: cwd,
        message: payload.message,
        includeUntracked: payload.includeUntracked,
      });
    case "git.stash.pop":
      return git.stashPop({ worktree: cwd, stash: payload.stash });
  }
}
