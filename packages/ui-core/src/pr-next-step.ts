import type { ForgePrRow, VerifyRun } from "@ace/protocol";

/**
 * What a pull request needs next, from the viewer's side (ADR 0094). One step per PR, so a list
 * can lead with what is theirs to do and say it as one word.
 */
export type PrNextStep =
  | "answer"
  | "review"
  | "resolve"
  | "fix"
  | "address"
  | "update"
  | "merge"
  | "wait"
  | "draft"
  | "none";

/** Steps that are the viewer's to take: the "Needs you" group. */
export const prStepsForYou: readonly PrNextStep[] = [
  "answer",
  "review",
  "resolve",
  "fix",
  "address",
  "update",
];

/** The button word for a step the viewer takes; undefined for steps with nothing to press. */
export const prStepLabels: Partial<Record<PrNextStep, string>> = {
  answer: "Answer",
  review: "Review",
  resolve: "Resolve conflicts",
  fix: "Fix checks",
  address: "Address review",
  update: "Update branch",
  merge: "Merge",
};

/** What a local check run says about a PR's current head: only a settled check counts. */
export type LocalCheckResult = "passed" | "failed" | "running" | undefined;

export interface PrNextStepInput {
  row: Pick<
    ForgePrRow,
    "state" | "author" | "ci" | "reviewDecision" | "reviewers" | "conflicting" | "behind"
  >;
  /** The signed-in GitHub login, when known. */
  viewer: string | undefined;
  /** A thread links this PR: ace made it or is working on it. */
  linked: boolean;
  /** That thread is waiting on the person (an approval, a question). */
  linkedNeedsYou: boolean;
  /** The latest local check of the PR's current head. */
  local: LocalCheckResult;
}

const same = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/** The PR's next step for the viewer: the first rule that matches, in ADR 0094's order. */
export function prNextStep(input: PrNextStepInput): PrNextStep {
  const { row, viewer } = input;
  if (row.state === "closed" || row.state === "merged") return "none";
  if (input.linkedNeedsYou) return "answer";
  const author = same(row.author, viewer);
  if (!author && (row.reviewers ?? []).some((login) => same(login, viewer))) return "review";
  if (row.state === "draft") return "draft";
  const owned = author || input.linked;
  const failing = row.ci === "failure" || input.local === "failed";
  if (owned && row.conflicting) return "resolve";
  if (owned && failing) return "fix";
  if (owned && row.reviewDecision === "CHANGES_REQUESTED") return "address";
  if (owned && row.behind) return "update";
  const approved = row.reviewDecision === "APPROVED" || row.reviewDecision == null;
  const running = row.ci === "pending" || input.local === "running";
  if (approved && !failing && !running && !row.conflicting && !row.behind) return "merge";
  return "wait";
}

/** The latest local check of `headSha` among a project's runs, as a next-step input. */
export function localCheckOf(
  runs: readonly VerifyRun[],
  pr: { owner: string; name: string; number: number },
  headSha: string | undefined,
): LocalCheckResult {
  if (!headSha) return undefined;
  const key = (owner: string, name: string) => `${owner}/${name}`.toLowerCase();
  const wanted = key(pr.owner, pr.name);
  let latest: VerifyRun | undefined;
  for (const run of runs) {
    if (run.target.kind !== "check") continue;
    const target = run.target.pr;
    if (target.pr.number !== pr.number || target.headSha.toLowerCase() !== headSha.toLowerCase())
      continue;
    if (key(target.pr.repository.owner, target.pr.repository.name) !== wanted) continue;
    if (!latest || run.createdAt > latest.createdAt) latest = run;
  }
  if (!latest) return undefined;
  if (latest.state === "passed") return "passed";
  if (latest.state === "failed") return "failed";
  if (latest.state === "queued" || latest.state === "running") return "running";
  return undefined;
}
