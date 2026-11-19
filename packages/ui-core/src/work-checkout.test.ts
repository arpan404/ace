import type { LinkedPullRequest, ThreadDetails } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import {
  checkoutMoveReasons,
  checkoutProblem,
  defaultFirst,
  dirtyMoveQuestion,
  linkedPrProblem,
  missingBranch,
  prSummary,
  staleLockOutcome,
} from "./work-checkout.ts";

const change = (
  over: Partial<NonNullable<ThreadDetails["workspaceChange"]>>,
): ThreadDetails["workspaceChange"] => ({
  commandId: "c1",
  state: "applied",
  at: 1,
  lossy: true,
  ...over,
});

const gone = (
  branch: NonNullable<NonNullable<ThreadDetails["checkoutMissing"]>["branch"]>,
  extra: ThreadDetails = {},
) =>
  checkoutProblem({
    ...extra,
    worktreeMissing: true,
    checkoutMissing: { kind: "worktree", branch },
  });
const labels = (problem: ReturnType<typeof checkoutProblem>) =>
  problem?.actions.map((action) => (action.kind === "move" ? action.label : action.kind));

describe("checkout moves", () => {
  it("refuses to move a checkout while its agents work", () => {
    const reasons = checkoutMoveReasons({
      status: "working",
      checkout: { mode: "local" },
      state: "ready",
    });
    expect(reasons.switchReason).toMatch(/Wait for the agents to stop/);
    expect(reasons.worktreeReason).toMatch(/Wait for the agents to stop/);
  });

  it("lets a settled local checkout switch branch or move into a worktree", () => {
    expect(
      checkoutMoveReasons({ status: "done", checkout: { mode: "local" }, state: "ready" }),
    ).toEqual({ switchReason: undefined, worktreeReason: undefined });
  });

  it("says a worktree is already its own, and that an unread checkout can't move yet", () => {
    expect(
      checkoutMoveReasons({ status: "done", checkout: { mode: "worktree" }, state: "ready" })
        .worktreeReason,
    ).toBe("Already in a worktree of its own");
    expect(
      checkoutMoveReasons({ status: "done", checkout: undefined, state: "loading" }).switchReason,
    ).toBe("Reading the checkout");
    expect(
      checkoutMoveReasons({ status: "done", checkout: undefined, state: "ready" }).switchReason,
    ).toBe("Not a git checkout");
  });

  it("lists the usual default branch first", () => {
    expect(defaultFirst(["feature", "develop", "main"])).toEqual(["main", "feature", "develop"]);
    expect(defaultFirst(["b", "a"])).toEqual(["b", "a"]);
  });

  it("asks about uncommitted changes in the words of the move", () => {
    expect(dirtyMoveQuestion("develop")).toMatchObject({
      detail: "Git carries them to develop unless they clash with it.",
      confirm: "Switch anyway, bringing changes along",
    });
    expect(dirtyMoveQuestion(undefined).confirm).toBe("Move anyway");
  });
});

describe("checkout problems", () => {
  it("offers Retry with the move as asked, and Clear, for a failed move", () => {
    const problem = checkoutProblem({
      mode: "local",
      workspaceChange: change({
        state: "failed",
        mode: "local",
        branch: "develop",
        error: "git_dirty_worktree",
      }),
    });
    expect(problem).toMatchObject({ kind: "move-failed", label: "Checkout move failed" });
    expect(problem?.detail).toBeTruthy();
    expect(problem?.actions).toEqual([
      { kind: "retry-move", move: { mode: "local", branch: "develop" } },
      { kind: "clear-move" },
    ]);
  });

  it("calls a move whose outcome wasn't confirmed unconfirmed, never failed or done", () => {
    expect(
      checkoutProblem({ workspaceChange: change({ state: "preparing", uncertain: true }) })?.label,
    ).toBe("Checkout move unconfirmed");
  });

  it("has nothing to say about an applied move", () => {
    expect(checkoutProblem({ workspaceChange: change({ state: "applied" }) })).toBeUndefined();
  });

  it("offers local or a new worktree when the worktree folder is gone", () => {
    expect(checkoutProblem({ worktreeMissing: true })?.actions).toEqual([
      { kind: "move", move: { mode: "local" }, label: "Move to local" },
      { kind: "move", move: { mode: "worktree" }, label: "Recreate worktree" },
    ]);
  });

  it("leads with Recreate when the gone worktree's branch is still free", () => {
    const problem = gone({ name: "ui/atmos", state: "free" });
    expect(problem?.detail).toContain("ui/atmos is still here");
    expect(labels(problem)).toEqual(["Recreate worktree", "Move to local"]);
  });

  it("names the base a new worktree starts from when the branch was deleted too", () => {
    const problem = gone(
      { name: "ui/atmos", state: "gone" },
      { base: { ref: "main", remote: "origin", head: "a".repeat(40) } },
    );
    expect(problem?.label).toBe("Worktree and branch removed");
    expect(problem?.detail).toBe(
      "ui/atmos was deleted too. A new worktree starts from origin/main.",
    );
    expect(labels(problem)).toEqual(["Move to local", "New worktree"]);
  });

  it("never offers to recreate on a branch another checkout has", () => {
    const local = gone({ name: "fix", state: "elsewhere", holder: "local" });
    expect(local?.detail).toContain("checked out in the local checkout");
    expect(labels(local)).toEqual(["Move to local", "New worktree"]);
    expect(gone({ name: "fix", state: "elsewhere", holder: "worktree" })?.detail).toContain(
      "another worktree",
    );
  });

  it("offers no move when the project's own folder is gone", () => {
    const problem = checkoutProblem({
      worktreeMissing: true,
      checkoutMissing: { kind: "project" },
      workspace: { id: "w", name: "ace", path: "/code/ace" },
    });
    expect(problem).toMatchObject({ kind: "project-missing", label: "Project folder missing" });
    expect(problem?.detail).toContain("/code/ace is gone");
    expect(problem?.actions).toEqual([]);
  });

  it("says where a gone checkout's branch is instead of its last sync state", () => {
    expect(missingBranch({ branch: "fix", ahead: 2 })).toBeUndefined();
    expect(
      missingBranch({
        worktreeMissing: true,
        branch: "fix",
        checkoutMissing: { kind: "worktree", branch: { name: "fix", state: "gone" } },
      }),
    ).toEqual({ name: "fix", where: "deleted" });
    expect(missingBranch({ worktreeMissing: true, branch: "fix" })).toEqual({
      name: "fix",
      where: "folder gone",
    });
  });

  it("shows a failed setup's output with Retry and Continue, and a skipped one quietly", () => {
    const failed = checkoutProblem({
      worktreeSetup: { state: "failed", details: ["npm ERR! missing"], at: 1 },
    });
    expect(failed).toMatchObject({ failed: true, output: ["npm ERR! missing"] });
    expect(failed?.actions.map((action) => action.kind === "setup" && action.action)).toEqual([
      "retry",
      "continue",
    ]);
    expect(
      checkoutProblem({
        worktreeSetup: { state: "skipped", reason: "read_only", details: [], at: 1 },
      }),
    ).toMatchObject({ failed: false, actions: [] });
  });
});

describe("stale locks", () => {
  it("says cleared only when the daemon retired a lock", () => {
    expect(staleLockOutcome({ ok: true, locksCleared: 1 }, { threadId: "t" }).title).toBe(
      "Lock cleared",
    );
    expect(staleLockOutcome({ ok: true, locksCleared: 0 }, { threadId: "t" }).title).toBe(
      "No lock is held now",
    );
  });

  it("names what still holds the lock", () => {
    expect(
      staleLockOutcome(
        { ok: false, locksCleared: 0, detail: "git (pid 42) still runs" },
        { workspaceId: "w" },
      ),
    ).toEqual({ ok: false, title: "The lock is still held", detail: "git (pid 42) still runs" });
  });
});

describe("linked pull requests", () => {
  const linked: LinkedPullRequest = {
    number: 7,
    repo: { forge: "github", host: "github.com", owner: "a", name: "b" },
    url: "https://github.com/a/b/pull/7",
    state: "open",
    updatedAt: 1,
  };

  it("reads a link's state with its checks, or with why it may be stale", () => {
    expect(prSummary({ state: "open", ci: "success" })).toBe("open · checks passed");
    expect(prSummary(linked, linkedPrProblem({ ...linked, unverified: true }))).toBe(
      "open · couldn't verify with GitHub",
    );
    expect(linkedPrProblem({ ...linked, deleted: true, unverified: true })).toBe("deleted");
    expect(linkedPrProblem(linked)).toBeUndefined();
  });
});
