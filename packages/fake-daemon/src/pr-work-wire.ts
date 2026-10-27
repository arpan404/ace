import { stackRebasedLocally } from "@ace/forge/stack-plan";
import type {
  CommandPayload,
  CommandResult,
  ForgeBrowserResult,
  ForgeCheck,
  ForgeCheckRun,
  ForgeStackWorkspace,
  WorkspaceActionRequest,
} from "@ace/protocol";

type StackChange = Extract<CommandPayload, { type: "forge.pr.stack.change" }>;
type ChecksCommand = Extract<CommandPayload, { type: "forge.hosted.checks" }>;
type Result = Omit<CommandResult, "commandId">;

/** A new revision of `sha`, as a rebase writes one. */
const rebased = (sha: string) => (sha.slice(1) + sha.slice(0, 1)).replace(/^./, "b");

/**
 * The work a pull request page starts beyond reading it: its stack (`forge.pr.stack`,
 * `forge.pr.stack.change`) and its check runs (`forge.pr.check`, `forge.hosted.checks`). A
 * stack change moves the stack's operation as `gh stack` would; a re-run or cancel moves the
 * run's state, so the page reads it back changed. Every change is kept for tests to read.
 */
export class FakePrWork {
  private stacks = new Map<number, ForgeStackWorkspace>();
  private runs = new Map<number, ForgeCheckRun>();
  /** Every stack change asked for, oldest first. */
  readonly stackChanges: StackChange[] = [];

  /** The stack `workspace` holds every one of its layers' pull requests. */
  seedStack(workspace: ForgeStackWorkspace): void {
    for (const layer of workspace.stack?.layers ?? []) this.stacks.set(layer.number, workspace);
  }
  /** Check run `run` answers `forge.pr.check` for its id. */
  seedCheckRun(run: ForgeCheckRun): void {
    this.runs.set(run.id, run);
  }

  read(op: WorkspaceActionRequest["operation"]): ForgeBrowserResult | undefined {
    if (op.op === "forge.pr.check") {
      const run = this.runs.get(op.checkRunId);
      return run ? { resource: "prCheck", value: run } : undefined;
    }
    if (op.op !== "forge.pr.stack" || !("number" in op)) return undefined;
    const workspace = this.stacks.get(op.number);
    return workspace ? { resource: "prStack", value: workspace } : undefined;
  }

  /** A re-run or cancel of a seeded workflow run; the checks it moves come back to restate. */
  checks(payload: ChecksCommand): { moved: Map<string, ForgeCheck["status"]> } {
    const moved = new Map<string, ForgeCheck["status"]>();
    for (const run of this.runs.values()) {
      if (run.workflow?.runId !== payload.action.runId) continue;
      const action = payload.action;
      const next: ForgeCheckRun =
        action.kind === "cancel"
          ? run.status === "pending"
            ? { ...run, status: "cancelled", conclusion: "cancelled" }
            : run
          : action.jobs === "all" || run.status !== "success"
            ? {
                ...run,
                status: "pending",
                conclusion: null,
                log: null,
                workflow: { ...run.workflow, attempt: run.workflow.attempt + 1 },
              }
            : run;
      this.runs.set(run.id, next);
      if (next !== run) moved.set(`check:${run.id}`, next.status);
    }
    return { moved };
  }

  command(payload: CommandPayload): Result | undefined {
    if (payload.type !== "forge.pr.stack.change") return undefined;
    this.stackChanges.push(payload);
    const workspace = this.stacks.get(payload.link.pr.number);
    const stack = workspace?.stack;
    if (!workspace || !stack) return { ok: false, error: "forge_not_found" };
    if (payload.expected.id !== stack.id) return { ok: false, error: "forge_conflict" };
    const local = workspace.local;
    const next: ForgeStackWorkspace = { ...workspace };
    const operation = (
      state: NonNullable<ForgeStackWorkspace["operation"]>["state"],
      message: string,
    ) => ({ action: payload.action, state, message }) as const;
    if (payload.action === "merge") {
      const numbers = payload.expected.layers
        .slice(0, stack.layers.findIndex((layer) => layer.number === payload.link.pr.number) + 1)
        .map((layer) => layer.number);
      next.stack = {
        ...stack,
        layers: stack.layers.map((layer) =>
          numbers.includes(layer.number) ? { ...layer, state: "MERGED" } : layer,
        ),
      };
      next.operation = operation("merged", `Merged ${numbers.map((n) => `#${n}`).join(", ")}`);
    } else if (
      payload.action === "rebase" ||
      payload.action === "continue" ||
      payload.action === "sync"
    ) {
      next.local = local && {
        ...local,
        branches: local.branches.map((branch) => ({ ...branch, head: rebased(branch.head) })),
      };
      next.movedLayers = [];
      next.operation = operation("push_partial", stackRebasedLocally);
    } else if (payload.action === "abort") {
      next.operation = operation("aborted", "Local branches are back where they were.");
    } else {
      const heads = new Map(local?.branches.map((branch) => [branch.pr?.number, branch.head]));
      next.stack = {
        ...stack,
        layers: stack.layers.map((layer) => ({
          ...layer,
          headSha: heads.get(layer.number) ?? layer.headSha,
        })),
      };
      next.operation = operation("rebased", "Published the stack to GitHub.");
    }
    this.seedStack(next);
    return { ok: true, stackOperation: next.operation ?? undefined };
  }
}
