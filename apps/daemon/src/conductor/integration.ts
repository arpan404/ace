import type { Effect, Fact, State } from "@ace/conductor";
import type { ServiceContext } from "../services/types.ts";
import type { RootBinding } from "./journal.ts";
import type { DeckWorktrees } from "./worktrees.ts";

export async function integrateCard(
  effect: Extract<Effect, { type: "merge" }>,
  state: State,
  root: RootBinding,
  context: ServiceContext,
  worktrees: DeckWorktrees,
): Promise<Fact[]> {
  const merged = await worktrees.git.integrate({
    worktree: root.path,
    revision: effect.completion.revision,
    key: effect.id,
  });
  if (effect.mode === "pr" && !merged.conflict) {
    const forge = context.services.workspaceActions?.forge;
    if (!forge || !root.baseBranch) throw new Error("deck_forge_executor_unavailable");
    const permitted = () => {
      const current = context.services.conductor?.state(state.id);
      return !!current && !["cancelling", "cancelled"].includes(current.phase);
    };
    if (!permitted()) throw new Error("deck_cancelled");
    await worktrees.git.push({ worktree: root.path, remote: "origin" });
    if (!permitted()) throw new Error("deck_cancelled");
    const status = await forge.ensurePr(
      root.thread,
      root.path,
      {
        branch: root.branch,
        base: root.baseBranch,
        title: state.spec.goal.slice(0, 256),
        summary: state.plan?.summary ?? state.spec.goal,
        template: { title: "{{title}}", body: "{{summary}}" },
        draft: false,
      },
      permitted,
    );
    if (!["open", "draft"].includes(status.state) || status.headSha !== merged.revision)
      throw new Error("deck_pr_revision_changed");
  }
  return [
    { type: "merge_result", operationId: effect.id, workstream: effect.workstream, ...merged },
  ];
}
export async function verifyCard(
  effect: Extract<Effect, { type: "verify" }>,
  root: RootBinding,
  context: ServiceContext,
  worktrees: DeckWorktrees,
): Promise<Fact[]> {
  let passed: boolean;
  let summary: string;
  if (effect.mode === "pr") {
    const forge = context.services.workspaceActions?.forge;
    if (!forge) throw new Error("deck_forge_executor_unavailable");
    const status = await forge.status(root.thread, root.path);
    if (!status || status.ci === "pending" || status.ci === "unknown")
      throw new Error("deck_ci_pending");
    passed =
      status.headSha === effect.revision &&
      ["open", "draft"].includes(status.state) &&
      status.ci === "success";
    summary = passed
      ? "CI passed at the exact reviewed Deck PR revision"
      : "Deck PR head or CI did not pass";
  } else {
    const revision = await worktrees.git.resolveCommit({ worktree: root.path, ref: "HEAD" });
    const status = await worktrees.git.status(root.path);
    passed =
      revision === effect.revision &&
      !status.conflicted.length &&
      !status.staged.length &&
      !status.unstaged.length &&
      !status.untracked.length;
    summary = passed
      ? "Reviewed revision integrated into the clean Deck branch"
      : "Deck integration revision or worktree changed";
  }
  return [
    {
      type: "verified",
      operationId: effect.id,
      workstream: effect.workstream,
      revision: effect.revision,
      passed,
      summary,
    },
  ];
}
