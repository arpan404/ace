import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { GitError, type GitService, type Worktree } from "@ace/git";
import type { ThreadDetails, ThreadId } from "@ace/protocol";
import { ManagedWorktrees } from "./managed-worktrees.ts";
import { checkoutCwd } from "./creation-preparation.ts";
import { WorkspaceChangeRefused } from "./engine/workspace-change.ts";
import type { WorkspaceChangeReservation } from "./engine/workspace-change.ts";
import type { Store } from "./store.ts";
import { recordedBaseRef } from "./worktree-base.ts";

type MoveGit = Pick<
  GitService,
  | "status"
  | "listWorktrees"
  | "createWorktree"
  | "switchBranch"
  | "repositoryInfo"
  | "pruneWorktrees"
  | "worktreeMetadata"
  | "branchHead"
>;
export interface MoveContext {
  store: Store;
  git: MoveGit;
  directory: string;
  now: () => number;
  machine: { host: string; name: string };
}
export interface Selection {
  mode: "local" | "worktree";
  branch?: string | undefined;
  allowUncommitted: boolean;
}

const absent = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (absent(error)) return false;
    throw error;
  }
}
/** The thread's own worktree location and branch name, derived from its id alone. */
export async function threadWorktree(
  directory: string,
  id: ThreadId,
): Promise<{ path: string; branch: string }> {
  const key = createHash("sha256").update(id).digest("hex");
  await mkdir(join(directory, "worktrees"), { recursive: true, mode: 0o700 });
  return {
    path: join(await realpath(join(directory, "worktrees")), key),
    branch: `ace/${key.slice(0, 24)}`,
  };
}
function sessionCwd(store: Store, id: ThreadId): string {
  const row = store.atomic((db) =>
    db.prepare("SELECT cwd FROM engine_sessions WHERE thread_id=?").get(id),
  );
  if (typeof row?.cwd !== "string") throw new Error("workspace_unavailable");
  return row.cwd;
}
/** A registered worktree whose folder is gone; Git lists it as prunable. */
export async function staleTree(tree: Worktree | undefined): Promise<boolean> {
  return Boolean(tree && (tree.prunable !== null || !(await exists(tree.path))));
}
/**
 * The thread's worktree, made or remade: a registered checkout is used as it is; one whose
 * folder was deleted is pruned and made again from its surviving branch. `branch` checks out
 * an existing branch; `newBranch` names one made at `baseRef` (the thread's own by default).
 */
export async function ensureThreadWorktree(
  context: MoveContext,
  id: ThreadId,
  project: string,
  input: { branch?: string | undefined; newBranch?: string | undefined; baseRef: string },
): Promise<{ path: string; branch: string; created: boolean }> {
  const { git, store } = context;
  const own = await threadWorktree(context.directory, id);
  let tree = (await git.listWorktrees(project)).find((entry) => entry.path === own.path);
  if (await staleTree(tree)) {
    await git.pruneWorktrees(project);
    tree = undefined;
  }
  if (tree) return { path: own.path, branch: tree.branch ?? own.branch, created: false };
  const branch = input.branch ?? input.newBranch ?? own.branch;
  await git.createWorktree({
    repo: project,
    path: own.path,
    branch,
    baseRef: input.branch ?? input.baseRef,
    reuseBranch: true,
  });
  await new ManagedWorktrees(store, context.directory).created(
    git,
    project,
    own.path,
    id,
    context.now(),
  );
  store.workspaceReservations.restoreRoot(own.path);
  return { path: own.path, branch, created: true };
}
/**
 * What a checkout move fences, and which checkout it rewrites. Switching the branch of the main
 * checkout rewrites the files of every thread working there, so they must all be quiet. A move
 * into the thread's own worktree rewrites only that worktree, and a move back to the main
 * checkout without a branch rewrites nothing: threads elsewhere in the project keep working.
 */
export async function moveReservation(
  context: MoveContext,
  id: ThreadId,
  project: string,
  selection: Pick<Selection, "mode" | "branch">,
): Promise<Pick<WorkspaceChangeReservation, "roots" | "writes" | "selection">> {
  const previous = sessionCwd(context.store, id);
  const source = (await exists(previous)) ? await realpath(previous) : previous;
  const root = await realpath(project);
  const own = await threadWorktree(context.directory, id);
  const recorded = {
    mode: selection.mode,
    ...(selection.branch ? { branch: selection.branch } : {}),
  };
  if (selection.mode === "local" && selection.branch)
    return { roots: [...new Set([source, root])], writes: [root], selection: recorded };
  if (selection.mode === "worktree")
    return { roots: [own.path], writes: [own.path], selection: recorded };
  return { roots: [own.path], writes: [], selection: recorded };
}
/** Refuse, before any write, a branch Git would not check out twice. */
async function assertBranchFree(
  git: MoveGit,
  project: string,
  branch: string,
  target: string,
): Promise<void> {
  const trees = await git.listWorktrees(project);
  const holder = trees.find((tree) => tree.branch === branch && tree.path !== target);
  if (holder) throw new WorkspaceChangeRefused("git_branch_checked_out");
}
/**
 * The branch a remade worktree goes back on: the one the gone checkout was on (the thread's own
 * branch when it didn't say), while it still exists and nothing else has it checked out.
 */
async function survivingBranch(
  git: MoveGit,
  project: string,
  branch: string,
): Promise<string | undefined> {
  if (!(await git.branchHead({ repo: project, branch }))) return undefined;
  const holders = await git.listWorktrees(project);
  for (const tree of holders) if (tree.branch === branch && !(await staleTree(tree))) return;
  return branch;
}
/**
 * A branch no ref has yet, for a worktree made as new: the thread's own name, else that name
 * numbered. Never an existing branch, whose old commits or other checkout would come along.
 */
async function freshBranch(git: MoveGit, project: string, name: string): Promise<string> {
  for (let n = 1; n <= 100; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`;
    if (!(await git.branchHead({ repo: project, branch: candidate }))) return candidate;
  }
  throw new WorkspaceChangeRefused("git_branch_exists");
}
/**
 * Where a gone worktree whose branch went too starts again: its base branch as it is now (the
 * remote's last fetched copy for a remote base), else where it first started. Never fetches.
 */
async function currentBase(
  git: MoveGit,
  project: string,
  details: ThreadDetails | undefined,
): Promise<string> {
  const base = details?.base;
  const head =
    base &&
    (await git.branchHead({ repo: project, branch: base.ref, remote: base.remote }).catch(() => {
      return undefined;
    }));
  return head || recordedBaseRef(details);
}
/** The checkout move itself. Everything before the first Git write is a refusal. */
export async function moveCheckout(
  context: MoveContext,
  id: ThreadId,
  selection: Selection,
): Promise<ThreadDetails> {
  const { store, git } = context;
  const thread = store.getThread(id);
  if (!thread || thread.deletedAt !== undefined) throw new Error("thread_not_found");
  const project = store.getWorkspacePath(thread.workspaceId);
  if (!project) throw new Error("workspace_not_found");
  const previous = sessionCwd(store, id);
  const root = await realpath(project);
  const own = await threadWorktree(context.directory, id);
  try {
    // A deleted checkout has nothing left to protect; it may move or be made again.
    if (await exists(previous)) {
      const status = await git.status(previous);
      if (status.conflicted.length)
        throw new GitError("conflicts", "Resolve conflicts before switching");
      if (
        !selection.allowUncommitted &&
        (status.staged.length || status.unstaged.length || status.untracked.length)
      )
        throw new GitError("dirty_worktree", "Commit or explicitly allow uncommitted changes");
    }
    if (selection.branch)
      await assertBranchFree(
        git,
        project,
        selection.branch,
        selection.mode === "worktree" ? own.path : root,
      );
  } catch (error) {
    if (error instanceof WorkspaceChangeRefused) throw error;
    throw new WorkspaceChangeRefused(
      error instanceof GitError
        ? `git_${error.code.replace(/^git_/, "")}`
        : "workspace_change_refused",
      { cause: error },
    );
  }
  let path = root;
  if (selection.mode === "worktree") {
    // Remaking a gone worktree keeps the thread on its branch while that branch survives;
    // with the branch gone or held elsewhere, it starts on a new branch from its base branch
    // as it is now.
    let branch = selection.branch;
    let newBranch: string | undefined;
    let baseRef = recordedBaseRef(thread.details);
    if (!branch && !(await exists(previous))) {
      branch = await survivingBranch(git, project, thread.details?.branch ?? own.branch);
      if (!branch) {
        newBranch = await freshBranch(git, project, own.branch);
        baseRef = await currentBase(git, project, thread.details);
      }
    }
    const made = await ensureThreadWorktree(context, id, project, { branch, newBranch, baseRef });
    path = made.path;
    if (!made.created && selection.branch)
      await git.switchBranch({
        worktree: path,
        branch: selection.branch,
        allowUncommitted: selection.allowUncommitted,
      });
    path = await checkoutCwd(await git.listWorktrees(project), root, path);
  } else if (selection.branch)
    await git.switchBranch({
      worktree: path,
      branch: selection.branch,
      allowUncommitted: selection.allowUncommitted,
    });
  const info = await git.repositoryInfo(path);
  // Switching to a named branch replaces the base the worktree was first made from.
  const {
    base,
    pullRequestWorkspace: _pullRequestWorkspace,
    worktreeMissing: _missing,
    checkoutMissing: _gone,
    ...rest
  } = thread.details ?? {};
  return {
    ...rest,
    ...(base && !selection.branch ? { base } : {}),
    mode: selection.mode,
    worktree: path,
    branch: info.branch,
    head: info.head,
    ahead: info.ahead,
    behind: info.behind,
    upstream: info.upstream,
    machine: context.machine,
    ...(selection.branch ? { baseBranch: selection.branch } : {}),
  };
}
