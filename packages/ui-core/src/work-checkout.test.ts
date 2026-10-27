import type { LinkedPullRequest, ThreadDetails } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import {
  checkoutMoveReasons,
  checkoutProblem,
  defaultFirst,
  dirtyMoveQuestion,
  linkedPrProblem,
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
