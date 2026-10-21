import { prFromUrl } from "@ace/forge/pr-reference";
import type { ForgeCheck, ForgePrStatus, ForgeRepository, ForgeMergeState } from "@ace/protocol";

/*
 * A linked pull request as the work card's PR popover reads it: its checks in a line, whether
 * it merges cleanly, the review threads still open, and why Merge or Auto-merge can't run. Plus
 * the two things people type about a PR: which one ("#42", a URL) and who should review it. Pure.
 */

export type PrTone = "success" | "failure" | "pending" | "none";

export interface PrOverview {
  ci: { tone: PrTone; text: string };
  /** Failing first, then running, then the rest, each group by name. */
  checks: readonly ForgeCheck[];
  merge: { tone: "clean" | "conflict" | "unknown"; text: string };
  /** Review threads nobody has resolved yet. */
  unresolved: number;
  /** Why Merge can't run now, when it can't. */
  mergeBlocked: string | undefined;
  /** Why Auto-merge can't be turned on, when it can't. */
  autoMergeBlocked: string | undefined;
}

const order: Record<ForgeCheck["status"], number> = {
  failure: 0,
  pending: 1,
  cancelled: 2,
  unknown: 3,
  success: 4,
};
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** The checks in one line; the card and the PR panel both read CI through it. */
export function ciLine(status: Pick<ForgePrStatus, "ci" | "checks">): PrOverview["ci"] {
  const total = status.checks.length;
  const failed = status.checks.filter((check) => check.status === "failure").length;
  const running = status.checks.filter((check) => check.status === "pending").length;
  if (status.ci === "failure" || failed)
    return { tone: "failure", text: `${failed || "Some"} of ${total || "the"} checks failed` };
  if (status.ci === "pending" || running)
    return {
      tone: "pending",
      text: total ? `Checks running · ${total - running} of ${total} done` : "Checks running",
    };
  if (status.ci === "success") return { tone: "success", text: `${plural(total, "check")} passed` };
  // "unknown" means GitHub's check state couldn't be read, not that the PR has none.
  if (status.ci === "unknown") return { tone: "none", text: "Checks unavailable" };
  return { tone: "none", text: "No checks reported" };
}

/** The base in words: its name, or "its base" while the thread has none recorded. */
const baseName = (base: string | undefined) => base ?? "its base";

function mergeLine(status: ForgePrStatus, base: string | undefined): PrOverview["merge"] {
  if (status.mergeability === "conflicting")
    return { tone: "conflict", text: `Conflicts with ${baseName(base)}` };
  if (status.mergeability === "mergeable")
    return { tone: "clean", text: `No conflicts with ${baseName(base)}` };
  return { tone: "unknown", text: "GitHub is still checking for conflicts" };
}

/**
 * Why Merge can't run now, or undefined when it can. The work card's Merge and the PR
 * panel's Merge PR both ask this, so they never disagree about a PR. GitHub's own branch
 * protection still has the last word.
 */
export function mergeGate(status: ForgePrStatus, base: string | undefined): string | undefined {
  if (status.state === "merged") return "Already merged";
  if (status.state === "closed") return "The pull request is closed";
  if (status.state === "draft") return "A draft can't merge: mark it ready for review on GitHub";
  if (status.state === "unknown")
    return "GitHub didn't report this PR's state: refresh, then retry";
  if (status.mergeability === "conflicting")
    return `Resolve the conflicts with ${baseName(base)} first`;
  if (status.mergeability === "unknown") return "GitHub is still checking for conflicts";
  const ci = ciLine(status).tone;
  if (ci === "failure") return "Fix the failing checks first";
  if (ci === "pending") return "Checks are still running: wait, or turn on auto-merge";
  if (status.ci === "unknown") return "Checks unavailable: refresh GitHub before merging";
  return undefined;
}

/**
 * How often to read a PR again while GitHub is still deciding something the person waits on:
 * running checks, or mergeability it hasn't computed yet. False once nothing is pending.
 */
export function prPollInterval(status: ForgePrStatus | null | undefined): number | false {
  if (!status || (status.state !== "open" && status.state !== "draft")) return false;
  const running = status.ci === "pending" || status.checks.some((c) => c.status === "pending");
  return running || status.mergeability === "unknown" ? prPollMs : false;
}
export const prPollMs = 15_000;

/** What a repository that refuses auto-merge, or an account that can't enable it, is told. */
export const noAutoMerge = "This repository doesn't allow auto-merge for this account.";

/** Only the host's capability establishes whether auto-merge can be enabled. */
export function autoMergeBlocker(state: ForgeMergeState | undefined): string | undefined {
  if (!state) return "Refresh GitHub merge state before enabling auto-merge";
  if (state.autoMerge) return "Auto-merge is already enabled";
  if (state.queue) return "Already in the merge queue";
  if (!state.canEnable) return noAutoMerge;
  return undefined;
}

export function prOverview(status: ForgePrStatus, base: string | undefined): PrOverview {
  const ci = ciLine(status);
  const reason = mergeGate(status, base);
  return {
    ci,
    checks: status.checks.toSorted(
      (a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name),
    ),
    merge: mergeLine(status, base),
    unresolved: status.reviewThreads.filter((thread) => !thread.resolved).length,
    mergeBlocked: reason,
    autoMergeBlocked: autoMergeBlocker(status.mergeState),
  };
}

export type MergeMethod = "squash" | "merge" | "rebase";

/** The menu's words for each way to merge, in the order GitHub lists them. */
export const mergeMethods: readonly { method: MergeMethod; label: string }[] = [
  { method: "squash", label: "Squash and merge" },
  { method: "merge", label: "Create a merge commit" },
  { method: "rebase", label: "Rebase and merge" },
];

/**
 * A number uses the checkout’s origin; an HTTPS address identifies its own repository.
 */
export function parsePrReference(
  text: string,
  repository: ForgeRepository | undefined,
  hosts: readonly string[] = ["github.com"],
): { number: number; repository?: ForgeRepository } | { error: string } {
  const value = text.trim();
  const bare = /^#?(\d{1,9})$/.exec(value);
  if (bare)
    return repository
      ? valid(Number(bare[1]))
      : { error: "Paste the pull request’s GitHub address. This checkout has no origin remote." };
  try {
    const ref = prFromUrl(value, hosts);
    const ours =
      repository &&
      `${ref.repository.host}/${ref.repository.owner}/${ref.repository.name}`.toLowerCase() ===
        `${repository.host}/${repository.owner}/${repository.name}`.toLowerCase();
    return ours ? { number: ref.number } : { number: ref.number, repository: ref.repository };
  } catch {
    return { error: "Enter a PR number like #42, or its HTTPS pull request address on GitHub" };
  }
}

const valid = (number: number) => (number > 0 ? { number } : { error: "PR numbers start at 1" });

/** "@mira, sam" → the GitHub logins to ask for review, or the first name that can't be one. */
export function parseReviewers(text: string): { reviewers: string[] } | { error: string } {
  const names = text
    .split(/[\s,]+/)
    .map((name) => name.replace(/^@/, ""))
    .filter(Boolean);
  const invalid = names.find((name) => !/^[\w-]{1,39}$/.test(name));
  if (invalid) return { error: `“${invalid}” isn't a GitHub username` };
  return { reviewers: [...new Set(names)].slice(0, 100) };
}
