import type { CommandResult, LinkedPullRequest, ThreadDetails, ThreadStatus } from "@ace/protocol";
import { actionErrorText } from "./action-errors.ts";
import type { Checkout, CheckoutPr } from "./checkout.ts";

/*
 * The thread's Work: where its checkout lives and what can move it. The web's Work card and the
 * phones' Work sheet decide the same things here: whether the checkout may move now, what stops
 * it, how a move that met uncommitted changes is asked about, and what clearing a stale Git
 * lock did.
 */

/** Agents or terminals are working in the checkout: it can't move under them. */
const liveStates: ReadonlySet<ThreadStatus["state"]> = new Set([
  "working",
  "needs_you",
  "waiting",
  "limited",
]);

/** How far the checkout has been read. */
export type CheckoutReadState = "loading" | "ready" | "none" | "error";

/**
 * Why the checkout can't switch branch, or move into a worktree, right now; undefined when it can.
 * Moving back to the local checkout follows `switchReason`.
 */
export function checkoutMoveReasons(input: {
  status: ThreadStatus["state"] | undefined;
  checkout: Pick<Checkout, "mode"> | undefined;
  state: CheckoutReadState;
}): { switchReason: string | undefined; worktreeReason: string | undefined } {
  const live =
    input.status && liveStates.has(input.status)
      ? "Wait for the agents to stop: the checkout can't move under live work"
      : undefined;
  const noCheckout =
    input.state === "loading"
      ? "Reading the checkout"
      : input.checkout
        ? undefined
        : input.state === "error"
          ? "Couldn't read the checkout"
          : "Not a git checkout";
  return {
    switchReason: noCheckout ?? live,
    worktreeReason:
      noCheckout ??
      (input.checkout?.mode === "worktree" ? "Already in a worktree of its own" : live),
  };
}

const defaultBranches = ["main", "master", "trunk", "develop"];

/** The usual default branch first, then the rest as the daemon listed them. */
export function defaultFirst(branches: readonly string[]): string[] {
  const first = defaultBranches.find((name) => branches.includes(name));
  return first ? [first, ...branches.filter((branch) => branch !== first)] : [...branches];
}

/** A checkout move: a mode, and for a branch switch in place the branch. */
export interface CheckoutMove {
  mode: "local" | "worktree";
  branch?: string | undefined;
}

/**
 * The question when a move met uncommitted changes. A branch switch brings them along (Git
 * refuses if they clash); any other move leaves them where they are.
 */
export function dirtyMoveQuestion(carriesTo: string | undefined): {
  title: string;
  detail: string;
  confirm: string;
} {
  return {
    title: "The checkout has uncommitted changes",
    detail: carriesTo
      ? `Git carries them to ${carriesTo} unless they clash with it.`
      : "They stay where they are, on the current branch, for you to commit later.",
    confirm: carriesTo ? "Switch anyway, bringing changes along" : "Move anyway",
  };
}

/** One way out of a checkout problem. `clear-move` releases what a move held, after asking. */
export type CheckoutProblemAction =
  | { kind: "retry-move"; move: CheckoutMove }
  | { kind: "clear-move" }
  | { kind: "move"; move: CheckoutMove; label: string }
  | { kind: "setup"; action: "retry" | "continue"; label: string };

/** What stops the thread's checkout, in the words both apps show. */
export interface CheckoutProblem {
  kind:
    | "move-failed"
    | "move-unconfirmed"
    | "worktree-missing"
    | "project-missing"
    | "setup-failed"
    | "setup-skipped";
  label: string;
  /** Why, when the daemon said. */
  detail: string | undefined;
  /** A failed or skipped setup's redacted output, newest last. */
  output: readonly string[];
  /** Failed and missing are loud; a skipped setup only informs. */
  failed: boolean;
  actions: readonly CheckoutProblemAction[];
}

/**
 * The checkout's problem, most urgent first: a move that failed or whose outcome ace couldn't
 * confirm (Retry asks for the same move; Clear releases it once confirmed), a worktree folder
 * that is gone (back to local, or a new worktree), or a setup script that failed (Retry, or
 * Continue without it; both let the held first message go) or was skipped as Read-only.
 */
export function checkoutProblem(details: ThreadDetails | undefined): CheckoutProblem | undefined {
  const change = details?.workspaceChange;
  if (change && (change.state === "failed" || change.uncertain)) {
    const move: CheckoutMove = {
      mode: change.mode ?? details?.mode ?? "local",
      ...(change.branch ? { branch: change.branch } : {}),
    };
    return {
      kind: change.uncertain ? "move-unconfirmed" : "move-failed",
      label: change.uncertain ? "Checkout move unconfirmed" : "Checkout move failed",
      detail: change.error ? actionErrorText(change.error) : undefined,
      output: [],
      failed: true,
      actions: [{ kind: "retry-move", move }, { kind: "clear-move" }],
    };
  }
  if (details?.worktreeMissing) return missingProblem(details);
  const setup = details?.worktreeSetup;
  if (setup?.state === "failed")
    return {
      kind: "setup-failed",
      label: "Setup script failed",
      detail: undefined,
      output: setup.details,
      failed: true,
      actions: [
        { kind: "setup", action: "retry", label: "Retry" },
        { kind: "setup", action: "continue", label: "Continue without setup" },
      ],
    };
  if (setup?.state === "skipped")
    return {
      kind: "setup-skipped",
      label: "Setup skipped: Read-only",
      detail: undefined,
      output: [],
      failed: false,
      actions: [],
    };
  return undefined;
}

const toLocal: CheckoutProblemAction = {
  kind: "move",
  move: { mode: "local" },
  label: "Move to local",
};
const toWorktree = (label: string): CheckoutProblemAction => ({
  kind: "move",
  move: { mode: "worktree" },
  label,
});

/** The branch a new worktree starts from, as the person named it: `main`, `origin/main`. */
function baseName(details: ThreadDetails): string | undefined {
  const { base } = details;
  if (base) return base.remote ? `${base.remote}/${base.ref}` : base.ref;
  return details.baseBranch && details.baseBranch !== "HEAD" ? details.baseBranch : undefined;
}

/** A gone checkout's problem: failed, with no output of its own. */
const missing = (
  label: string,
  detail: string | undefined,
  actions: CheckoutProblemAction[],
): CheckoutProblem => ({
  kind: "worktree-missing",
  label,
  detail,
  output: [],
  failed: true,
  actions,
});

/**
 * A checkout whose folder is gone, by what Git still has of it. The project's own folder gone
 * leaves nowhere to move. A worktree whose branch survives is made again on it; one whose
 * branch is checked out elsewhere or deleted can go back to local or start a new worktree,
 * which the daemon makes on a branch of its own from the thread's base. A daemon that sent
 * only the flag gets both ways back, unexplained.
 */
function missingProblem(details: ThreadDetails): CheckoutProblem {
  const gone = details.checkoutMissing;
  if (gone?.kind === "project")
    return {
      ...missing(
        "Project folder missing",
        `${details.workspace?.path ?? "The project's folder"} is gone. Put the folder back to keep working in this thread.`,
        [],
      ),
      kind: "project-missing",
    };
  const branch = gone?.branch;
  if (!branch)
    return missing("Worktree missing", undefined, [toLocal, toWorktree("Recreate worktree")]);
  const base = baseName(details);
  const fresh = base
    ? `A new worktree starts from ${base}.`
    : "A new worktree starts from the local checkout's commit.";
  switch (branch.state) {
    case "free":
      return missing(
        "Worktree missing",
        `${branch.name} is still here. Recreate worktree puts the thread back on it.`,
        [toWorktree("Recreate worktree"), toLocal],
      );
    case "gone":
      return missing("Worktree and branch removed", `${branch.name} was deleted too. ${fresh}`, [
        toLocal,
        toWorktree("New worktree"),
      ]);
    case "elsewhere":
      return missing(
        "Worktree missing",
        branch.holder === "local"
          ? `${branch.name} is checked out in the local checkout now. Move to local carries on there.`
          : `${branch.name} is checked out in another worktree. ${fresh}`,
        [toLocal, toWorktree("New worktree")],
      );
  }
}

/**
 * The branch of a checkout whose folder is gone, as the card's Branch row says it instead of
 * its last sync state: its name, and where it is now ("deleted", "in the local checkout").
 * Undefined while the checkout is there, or when the daemon didn't say what it was on.
 */
export function missingBranch(
  details: ThreadDetails | undefined,
): { name: string; where: string } | undefined {
  if (!details?.worktreeMissing) return undefined;
  const branch = details.checkoutMissing?.branch;
  const name = branch?.name ?? details.branch;
  if (!name) return undefined;
  const where =
    branch?.state === "gone"
      ? "deleted"
      : branch?.state === "elsewhere"
        ? branch.holder === "local"
          ? "in the local checkout"
          : "in another worktree"
        : "folder gone";
  return { name, where };
}

/** Whose lock: a thread's checkout (a message it stopped) or a project's repository (a start). */
export type StaleLockTarget = { threadId: string } | { workspaceId: string };

/**
 * What "Clear stale lock" did, in words: cleared, already free, or still held (with what holds
 * it, when the daemon said). A lock that had already cleared on its own isn't "cleared" by this.
 */
export function staleLockOutcome(
  result: Pick<CommandResult, "ok" | "locksCleared" | "detail">,
  target: StaleLockTarget,
): { ok: boolean; title: string; detail: string } {
  if (!result.ok)
    return {
      ok: false,
      title: "The lock is still held",
      detail:
        result.detail ??
        "The ace daemon that holds it may still be running. Stop it, or restart this daemon, then try again.",
    };
  return {
    ok: true,
    title: result.locksCleared ? "Lock cleared" : "No lock is held now",
    detail: "threadId" in target ? "Retry to send it." : "Retry to start the thread.",
  };
}

/** Why a pull request's state may be stale. */
export type PrProblem = "unverified" | "deleted" | "unreadable";

const checks: Partial<Record<NonNullable<CheckoutPr["ci"]>, string>> = {
  success: "checks passed",
  failure: "checks failing",
  pending: "checks running",
  unknown: "checks unavailable",
};

const problems: Record<PrProblem, string> = {
  unverified: "couldn't verify with GitHub",
  deleted: "repository deleted",
  unreadable: "couldn't read from GitHub",
};

/** "open · checks passed", in words a screen reader hears too. */
export function prSummary(pr: Pick<CheckoutPr, "state" | "ci">, problem?: PrProblem): string {
  if (problem) return `${pr.state} · ${problems[problem]}`;
  const ci = pr.ci && checks[pr.ci];
  return ci ? `${pr.state} · ${ci}` : pr.state;
}

/** A linked pull request's last known problem, from the link alone. */
export function linkedPrProblem(pr: LinkedPullRequest): PrProblem | undefined {
  if (pr.deleted) return "deleted";
  if (pr.unverified) return "unverified";
  return undefined;
}
