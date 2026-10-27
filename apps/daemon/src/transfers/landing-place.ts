import { GitError } from "@ace/git";
import type { PinnedDirectory } from "@ace/workspace";
import type { ThreadId, TransferCommit, WorkspaceId } from "@ace/protocol";
import type { IncomingRecord } from "./incoming-rows.ts";
import type { Made } from "./landing-made.ts";
import { headRef, incomingRef, type Landed, type LandingDeps } from "./landing-types.ts";

/** The branch a detached HEAD lands on: it is the only name the commit gets there. */
const detachedBranch = (head: string) => `detached-${head.slice(0, 12)}`;

/** The checkout the work lands in: one this transfer made, or a project this machine had. */
export interface LandingProject {
  path: string;
  workspaceId: WorkspaceId;
  fresh: boolean;
  directory?: PinnedDirectory | undefined;
  /** A folder sent again: files its copy here already had and kept. */
  kept?: number | undefined;
}

/**
 * Where the branch goes in a project this machine already had. Only a clean, idle checkout on
 * the same branch is brought forward, and only when that is a fast-forward; any other checkout
 * is left alone and the work lands on a branch of its own. Without a thread nothing opens a
 * checkout on that branch, so uncommitted changes ride on it as its top commit.
 */
async function intoExisting(
  deps: LandingDeps,
  record: IncomingRecord,
  commit: TransferCommit & { head: string },
  project: LandingProject,
  branch: string,
): Promise<{ branch: string; inCheckout: boolean; changesCommitted: boolean }> {
  const { git } = deps;
  const state = await git.checkoutState(project.path);
  const idle =
    commit.thread?.mode !== "worktree" &&
    state.clean &&
    state.branch === branch &&
    !deps.projects.busy(project.workspaceId);
  if (idle) {
    try {
      if (state.head !== commit.head) await git.fastForward(project.path, commit.head);
      return { branch, inCheckout: true, changesCommitted: false };
    } catch (error) {
      // The branch here has commits of its own: the transfer lands beside them.
      if (!(error instanceof GitError && error.code === "head_moved")) throw error;
    }
  }
  const carried = !commit.thread && commit.changes ? commit.changes.commit : undefined;
  const tip = carried ?? commit.head;
  const machine = record.begin.origin.hostName;
  const landing = await git.landingBranch(project.path, { branch, commit: tip, machine });
  if (!landing.existing) await git.createBranch(project.path, landing.branch, tip);
  return { branch: landing.branch, inCheckout: false, changesCommitted: Boolean(carried) };
}

/**
 * Puts the branch and the uncommitted changes in a checkout, and starts the thread. In a folder
 * this transfer made, every write goes through its held descriptor, never its path. See
 * `Transfer.result` for what the result promises a client.
 */
export async function place(
  deps: LandingDeps,
  made: Made,
  record: IncomingRecord,
  commit: TransferCommit,
  project: LandingProject,
  signal: AbortSignal,
): Promise<Landed> {
  const { git } = deps;
  const isGit = record.method !== "archive";
  const machine = record.begin.origin.hostName;
  const wantsWorktree = commit.thread?.mode === "worktree";
  // A detached HEAD lands on a branch of its own at that exact commit.
  let branch = commit.branch ?? (commit.head ? detachedBranch(commit.head) : undefined);
  let inCheckout = true;
  let changesCommitted = false;
  const held = project.directory ? { directoryFd: project.directory.fd } : undefined;
  if (isGit && branch && commit.head) {
    if (project.fresh) {
      await git.checkoutBranch(project.path, { name: branch, commit: commit.head }, held);
    } else {
      const head = commit.head;
      ({ branch, inCheckout, changesCommitted } = await intoExisting(
        deps,
        record,
        { ...commit, head },
        project,
        branch,
      ));
    }
  }
  signal.throwIfAborted();
  const changes = commit.changes;
  const apply = async (path: string, directory?: PinnedDirectory) => {
    const pin = directory ? { directoryFd: directory.fd } : undefined;
    if (changes && !changesCommitted) await git.applyChanges(path, changes.commit, pin);
    signal.throwIfAborted();
    await deps.landed?.(directory ?? path, signal);
    signal.throwIfAborted();
  };
  // The project's own checkout: the folder this transfer made, held, or one it reused.
  const inProject = () => apply(project.path, project.directory);
  const branchOnly = !commit.thread && !inCheckout;
  const result = (threadId?: ThreadId): Landed => ({
    workspaceId: project.workspaceId,
    path: project.path,
    ...(branch && isGit ? { branch } : {}),
    ...(threadId ? { threadId } : {}),
    ...(branchOnly ? { branchOnly: true } : {}),
    ...(project.kept === undefined ? {} : { keptFiles: project.kept }),
  });
  let landed: Landed;
  if (commit.thread) {
    const worktree = isGit && (wantsWorktree || !inCheckout);
    if (!worktree) await inProject();
    const keep = (threadId: ThreadId) => {
      made.kept = true;
      deps.created(result(threadId));
    };
    const threadId = await deps.threads.create({
      key: `transfer:${record.transferId}:${deps.attempt}`,
      deviceId: record.deviceId,
      workspaceId: project.workspaceId,
      mode: worktree ? "worktree" : "local",
      base: branch,
      thread: commit.thread,
      machine: { hostId: record.begin.origin.hostId, name: machine },
      ...(worktree ? { prepare: apply } : {}),
      cutoff: () => {
        signal.throwIfAborted();
        deps.cutoff();
      },
      // In the thread's own transaction: a crash right after can't roll the thread back.
      made: keep,
    });
    // A thread this attempt had already made, returned again.
    if (!made.kept) keep(threadId);
    landed = result(threadId);
  } else {
    // A busy checkout keeps its tracked files; only ignored files it lacks are added.
    if (inCheckout) await inProject();
    else await deps.landed?.(project.path, signal);
    signal.throwIfAborted();
    deps.cutoff();
    made.kept = true;
    landed = result();
    deps.created(landed);
  }
  if (isGit) {
    const refs = [
      ...(changes ? [changes.ref] : []),
      headRef(record.transferId),
      incomingRef(record.transferId),
    ];
    for (const ref of refs) await git.deleteRef(project.path, ref, held).catch(() => undefined);
  }
  return landed;
}
