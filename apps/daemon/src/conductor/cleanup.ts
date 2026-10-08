import type { State } from "@ace/conductor";
import type { ServiceContext } from "../services/types.ts";
import type { DelegationService } from "../agent-control/delegations.ts";
import { ProjectStorage } from "../project-storage.ts";
import type { ExecutionJournal, RootBinding, LaneBinding } from "./journal.ts";
import type { DeckWorktrees } from "./worktrees.ts";

/** Terminal cleanup retains thread history and the integration branch for the person. */
export async function cleanupDeck(
  state: State,
  context: ServiceContext,
  journal: ExecutionJournal,
  worktrees: DeckWorktrees,
  delegations: DelegationService,
): Promise<void> {
  if (!["done", "cancelled"].includes(state.phase)) throw new Error("deck_cleanup_live");
  const root = journal.root(state.id);
  if (!root) return;
  const family = delegations.journal.family(root.thread);
  for (const edge of family.toSorted((a, b) => b.depth - a.depth))
    await context.services.engine?.retireSession(edge.childId);
  const projects =
    context.services.projects?.catalog ?? new ProjectStorage(context.store, context.now);
  for (let after = 0; ;) {
    const page = journal.lanePage(state.id, after);
    for (const binding of page.bindings) {
      if (
        binding.workspace &&
        !context.store.atomic((db) =>
          db
            .prepare("SELECT 1 FROM workspace_unregistered WHERE workspace_id=?")
            .get(binding.workspace),
        )
      )
        projects.remove(
          binding.workspace,
          false,
          (id) => context.services.workspaceActions?.hasOwnedWork(id) ?? false,
        );
      await removeTree(root, binding, journal, worktrees);
    }
    if (page.after === undefined) break;
    after = page.after;
  }
  await removeTree(root, root, journal, worktrees);
}

async function removeTree(
  root: RootBinding,
  binding: Pick<LaneBinding, "path" | "branch">,
  journal: ExecutionJournal,
  worktrees: DeckWorktrees,
): Promise<void> {
  const tree = (await worktrees.git.listWorktrees(root.repo)).find(
    (entry) => entry.path === binding.path,
  );
  if (tree && tree.branch !== binding.branch) throw new Error("deck_worktree_identity_changed");
  let head = journal.cleanupHead(root.run, binding.path);
  if (!head) {
    try {
      head = await worktrees.git.resolveCommit({
        worktree: root.repo,
        ref: `refs/heads/${binding.branch}`,
      });
    } catch (error) {
      if (!tree && error instanceof Error && "code" in error && error.code === "invalid_ref")
        return;
      throw error;
    }
    journal.saveCleanupHead(root.run, binding.path, head);
  }
  if (tree) {
    const current = await worktrees.git.resolveCommit({
      worktree: root.repo,
      ref: `refs/heads/${binding.branch}`,
    });
    if (current !== head) throw new Error("deck_branch_identity_changed");
    await worktrees.git.removeWorktree({ repo: root.repo, path: binding.path, force: true });
  }
  if (binding.path !== root.path)
    await worktrees.git.deleteBranch({
      repo: root.repo,
      branch: binding.branch,
      expectedHead: head,
    });
}
