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

/** Commands that rewrite the checkout's files wholesale, refused while the agent works. */
const treeRewriting = new Set<string>([
  "git.branch.switch",
  "git.branch.create",
  "git.pull",
  "git.stash.push",
  "git.stash.pop",
]);

export interface SourceControlCommandContext {
  git: WorkspaceGit;
  store: Store;
  threadId: ThreadId;
  cwd: string;
  runsProviderWork: (id: ThreadId) => boolean;
  trashFile?: ((threadId: ThreadId, path: string) => Promise<void>) | undefined;
  refreshDetails: () => Promise<void>;
}

/** Execute one thread-scoped source control command, refreshing details on success. */
export async function runSourceControlCommand(
  context: SourceControlCommandContext,
  payload: SourceControlCommandPayload,
): Promise<Omit<CommandResult, "commandId">> {
  const { git, store, threadId, cwd, runsProviderWork, trashFile, refreshDetails } = context;

  const refresh = () => refreshDetails().catch(() => {});

  if (treeRewriting.has(payload.type) && isThreadAgentBusy(store, threadId, runsProviderWork))
    return { ok: false, error: "agent_working" };

  switch (payload.type) {
    case "git.stage":
      await git.stage({ worktree: cwd, paths: payload.paths });
      await refresh();
      return { ok: true };
    case "git.unstage":
      await git.unstage({ worktree: cwd, paths: payload.paths });
      await refresh();
      return { ok: true };
    case "git.discard":
      await git.discard({
        worktree: cwd,
        paths: payload.paths,
        includeUntracked: payload.includeUntracked,
        ...(trashFile ? { trash: (_root, path) => trashFile(threadId, path) } : {}),
      });
      await refresh();
      return { ok: true };
    case "git.branch.switch":
      await git.switchBranch({
        worktree: cwd,
        branch: payload.branch,
        remote: payload.remote,
        allowUncommitted: true,
      });
      await refresh();
      return { ok: true };
    case "git.branch.create":
      await git.createBranch({ worktree: cwd, branch: payload.branch });
      await refresh();
      return { ok: true };
    case "git.pull":
      await git.pull({ worktree: cwd, remote: payload.remote });
      await refresh();
      return { ok: true };
    case "git.fetch":
      await git.fetch({ worktree: cwd, remote: payload.remote });
      await refresh();
      return { ok: true };
    case "git.stash.push":
      await git.stashPush({
        worktree: cwd,
        message: payload.message,
        includeUntracked: payload.includeUntracked,
      });
      await refresh();
      return { ok: true };
    case "git.stash.pop":
      await git.stashPop({ worktree: cwd, stash: payload.stash });
      await refresh();
      return { ok: true };
  }
}
