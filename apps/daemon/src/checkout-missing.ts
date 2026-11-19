import { realpath } from "node:fs/promises";
import type { GitService } from "@ace/git";
import type { ThreadDetails } from "@ace/protocol";
import { exists, staleTree } from "./workspace-move.ts";

export type CheckoutMissing = NonNullable<ThreadDetails["checkoutMissing"]>;
type MissingGit = Pick<GitService, "listWorktrees" | "branchHead">;

/**
 * What Git still has of a checkout whose folder is gone. The project's own folder gone leaves
 * nothing to move to (`project`). Otherwise the branch the checkout was on is free to check out
 * again, deleted, or checked out elsewhere: in the project's own checkout or another worktree.
 * A Git that can't be read still reports the worktree missing, without the branch.
 */
export async function readMissingCheckout(
  git: MissingGit,
  input: { cwd: string; project: string; branch: string | null | undefined },
): Promise<CheckoutMissing> {
  if (!(await exists(input.project))) return { kind: "project" };
  const project = await realpath(input.project);
  if (input.cwd === project) return { kind: "project" };
  const name = input.branch;
  if (!name) return { kind: "worktree" };
  try {
    for (const tree of await git.listWorktrees(project)) {
      if (tree.branch !== name || tree.path === input.cwd || (await staleTree(tree))) continue;
      return {
        kind: "worktree",
        branch: { name, state: "elsewhere", holder: tree.path === project ? "local" : "worktree" },
      };
    }
    const head = await git.branchHead({ repo: project, branch: name });
    return { kind: "worktree", branch: { name, state: head ? "free" : "gone" } };
  } catch {
    return { kind: "worktree" };
  }
}

/** The thread's checkout can't be used: its folder is gone, or storage cleanup removed it. */
export class CheckoutMissingError extends Error {
  readonly code = "worktree_missing";
  readonly title = "This thread's folder is gone";
  constructor() {
    super("worktree_missing");
  }
}
