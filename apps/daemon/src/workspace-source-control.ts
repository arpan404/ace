import type { Command, CommandResult, ThreadId } from "@ace/protocol";
import type { Store } from "./store.ts";
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
 * Whether an agent turn or background provider work is active in `threadId`'s checkout.
 * Switching branches or pulling underneath a live agent corrupts its view of the tree.
 */
export function isThreadAgentBusy(
  store: Store,
  threadId: ThreadId,
  runsProviderWork: (id: ThreadId) => boolean,
): boolean {
  if (runsProviderWork(threadId)) return true;
  const thread = store.getThread(threadId);
  if (!thread) return false;
  const state = thread.status.state;
  if (state === "working" || state === "needs_you") return true;
  if (state === "waiting") {
    // A paused recovery hold runs nothing until Continue.
    if (thread.status.on === "queue") {
      const paused = store.atomic((db) =>
        Boolean(
          db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_queue'")
            .get() &&
          db.prepare("SELECT 1 FROM engine_queue WHERE thread_id=? AND paused=1").get(threadId),
        ),
      );
      if (paused) return false;
    }
    return true;
  }
  return false;
}

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

  if (
    payload.type === "git.branch.switch" ||
    payload.type === "git.branch.create" ||
    payload.type === "git.pull"
  ) {
    if (isThreadAgentBusy(store, threadId, runsProviderWork)) {
      return { ok: false, error: "thread_tree_is_live" };
    }
  }

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
