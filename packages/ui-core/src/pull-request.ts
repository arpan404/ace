import type { ForgeCheck, ForgePrStatus, ForgeRepository } from "@ace/protocol";

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

function ciLine(status: ForgePrStatus): PrOverview["ci"] {
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
  return { tone: "none", text: "No checks reported" };
}

function mergeLine(status: ForgePrStatus, base: string): PrOverview["merge"] {
  if (status.mergeability === "conflicting")
    return { tone: "conflict", text: `Conflicts with ${base}` };
  if (status.mergeability === "mergeable")
    return { tone: "clean", text: `No conflicts with ${base}` };
  return { tone: "unknown", text: "GitHub is still checking for conflicts" };
}

/** Reasons that stop both Merge and Auto-merge. */
function blocked(status: ForgePrStatus, base: string, ci: PrTone): string | undefined {
  if (status.state === "merged") return "Already merged";
  if (status.state === "closed") return "The pull request is closed";
  if (status.state === "draft") return "A draft can't merge: mark it ready for review on GitHub";
  if (status.mergeability === "conflicting") return `Resolve the conflicts with ${base} first`;
  if (ci === "failure") return "Fix the failing checks first";
  return undefined;
}

export function prOverview(status: ForgePrStatus, base: string): PrOverview {
  const ci = ciLine(status);
  const reason = blocked(status, base, ci.tone);
  return {
    ci,
    checks: status.checks.toSorted(
      (a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name),
    ),
    merge: mergeLine(status, base),
    unresolved: status.reviewThreads.filter((thread) => !thread.resolved).length,
    mergeBlocked: reason,
    autoMergeBlocked:
      reason ??
      (ci.tone === "pending" || status.mergeability === "unknown"
        ? undefined
        : "Nothing to wait for: merge it now"),
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
 * The PR a person means by "42", "#42" or its address, in this repository. An address of
 * another repository or forge is refused with the reason.
 */
export function parsePrReference(
  text: string,
  repository: ForgeRepository,
): { number: number } | { error: string } {
  const value = text.trim();
  const bare = /^#?(\d{1,9})$/.exec(value);
  if (bare) return valid(Number(bare[1]));
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: "Enter a PR number like 42, or its address on GitHub" };
  }
  // github.com/<owner>/<name>/pull/<number>, perhaps with /files or /checks after it.
  const path = url.pathname.split("/").filter(Boolean);
  const at = path.lastIndexOf("pull");
  const number = path[at + 1] ?? "";
  if (at < 2 || !/^\d{1,9}$/.test(number)) return { error: "That address isn't a pull request" };
  const ours =
    url.hostname.toLowerCase() === repository.host.toLowerCase() &&
    path.slice(0, at).join("/").toLowerCase() ===
      `${repository.owner}/${repository.name}`.toLowerCase();
  if (!ours) return { error: `That PR isn't in ${repository.owner}/${repository.name}` };
  return valid(Number(number));
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
