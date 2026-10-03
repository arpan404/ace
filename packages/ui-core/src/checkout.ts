import type { ForgePrStatus, ForgeRepository, ThreadDetails } from "@ace/protocol";

/** A thread's pull request: the linked one from details, refined by the forge's live status. */
export interface CheckoutPr {
  number: number;
  state: "open" | "draft" | "merged" | "closed";
  url?: string | undefined;
  title?: string | undefined;
  /** Combined CI state, once the forge has reported it. */
  ci?: ForgePrStatus["ci"] | undefined;
}

/** What the header's git control needs to know about a thread's checkout. */
export interface Checkout {
  mode: "worktree" | "local";
  /** Null on a detached HEAD. */
  branch: string | null;
  baseBranch: string;
  head: string | null;
  /** Files with uncommitted changes, and their line counts. */
  changed: number;
  additions: number;
  deletions: number;
  /** Commits the remote branch doesn't have (0 when there is no upstream yet). */
  ahead: number;
  behind: number;
  repository: ForgeRepository | undefined;
  pr: CheckoutPr | undefined;
}

/**
 * The checkout from a thread's live details and, when the forge answered, its PR status.
 * Undefined until the daemon has read the checkout (no worktree and no branch yet).
 */
export function checkoutOf(
  details: ThreadDetails | undefined,
  status?: ForgePrStatus | null,
): Checkout | undefined {
  if (!details || (details.worktree === undefined && details.branch === undefined))
    return undefined;
  return {
    mode: details.mode ?? "local",
    branch: details.branch ?? null,
    baseBranch: details.baseBranch ?? "main",
    head: details.head ?? null,
    changed: details.diff?.files ?? 0,
    additions: details.diff?.additions ?? 0,
    deletions: details.diff?.deletions ?? 0,
    ahead: details.ahead ?? 0,
    behind: details.behind ?? 0,
    repository: details.repository,
    pr: pullRequest(details.linkedPr, status),
  };
}

function pullRequest(
  linked: ThreadDetails["linkedPr"],
  status: ForgePrStatus | null | undefined,
): CheckoutPr | undefined {
  if (status && status.state !== "unknown")
    return {
      number: status.ref.number,
      state: status.state,
      url: status.url,
      title: status.title,
      ci: status.ci,
    };
  if (!linked) return undefined;
  return { number: linked.number, state: linked.state, url: linked.url };
}

/** Why a checkout can't open a pull request, or undefined when it can. */
export function prBlocker(checkout: Checkout): string | undefined {
  if (!checkout.branch) return "The checkout is on a detached HEAD.";
  if (checkout.branch === checkout.baseBranch)
    return `The checkout is on ${checkout.baseBranch}, the branch a PR would merge into.`;
  if (!checkout.repository) return "The daemon found no GitHub or GitLab remote for this checkout.";
  return undefined;
}

export type GitStep =
  | { kind: "commit" }
  | { kind: "push" }
  | { kind: "create-pr"; blocked: string | undefined }
  | { kind: "pr"; pr: CheckoutPr };

const live = (pr: CheckoutPr | undefined): pr is CheckoutPr =>
  pr !== undefined && (pr.state === "open" || pr.state === "draft");

/**
 * The next step towards a merged change: commit what is uncommitted, push what the remote
 * lacks, open a PR, then follow the open PR. A merged or closed PR starts the walk again.
 */
export function nextGitStep(checkout: Checkout): GitStep {
  if (checkout.changed > 0) return { kind: "commit" };
  if (checkout.ahead > 0) return { kind: "push" };
  if (live(checkout.pr)) return { kind: "pr", pr: checkout.pr };
  return { kind: "create-pr", blocked: prBlocker(checkout) };
}
