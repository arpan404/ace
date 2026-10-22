import type { SidebarReader } from "@ace/client";
import type { ForgePrRow, ForgeRepository, VerifyRun } from "@ace/protocol";
import type { RowGroup } from "./forge-lists.ts";
import {
  localCheckOf,
  prNextStep,
  prStepsForYou,
  type LocalCheckResult,
  type PrNextStep,
} from "./pr-next-step.ts";

/** A thread working on a pull request or issue, as the thread list knows it. */
export interface LinkedThread {
  id: string;
  title: string;
  /** It waits on the person: an approval, a question. */
  needsYou: boolean;
}
export type LinkedThreads = ReadonlyMap<string, LinkedThread>;

/** One key per PR or issue: repository and number, case-insensitive like GitHub's names. */
export function workKey(repository: Pick<ForgeRepository, "owner" | "name">, number: number) {
  return `${repository.owner}/${repository.name}#${number}`.toLowerCase();
}

/**
 * Which PRs and issues the loaded threads are linked to, newest thread first: the thread list
 * already carries every link, so a row can name its thread without asking the daemon. Archived
 * threads are left out.
 */
export function linkedWork(reader: Pick<SidebarReader, "ids" | "thread">): {
  pulls: LinkedThreads;
  issues: LinkedThreads;
} {
  const pulls = new Map<string, LinkedThread>();
  const issues = new Map<string, LinkedThread>();
  for (const id of reader.ids) {
    const thread = reader.thread(id);
    if (!thread || thread.archivedAt !== undefined) continue;
    const linked = {
      id: thread.id,
      title: thread.title,
      needsYou: thread.status.state === "needs_you",
    };
    for (const pr of thread.details?.linkedPrs ?? []) {
      const key = workKey(pr.repo, pr.number);
      if (!pulls.has(key)) pulls.set(key, linked);
    }
    for (const issue of thread.details?.linkedIssues ?? []) {
      const key = workKey(issue.repository, issue.number);
      if (!issues.has(key)) issues.set(key, linked);
    }
  }
  return { pulls, issues };
}

/*
 * The open list by what each PR needs next (ADR 0094): what is the viewer's to do, what is
 * ready to merge, what waits on someone else, and drafts. Pure.
 */

export interface RowStep {
  step: PrNextStep;
  local: LocalCheckResult;
}

/** A row's next step for `viewer`, from its linked thread and its latest local check. */
export function rowStep(
  row: ForgePrRow,
  viewer: string | undefined,
  thread: LinkedThread | undefined,
  runs: readonly VerifyRun[],
): RowStep {
  const local = localCheckOf(
    runs,
    { owner: row.ref.repository.owner, name: row.ref.repository.name, number: row.ref.number },
    row.headSha,
  );
  const step = prNextStep({
    row,
    viewer,
    linked: thread !== undefined,
    linkedNeedsYou: thread?.needsYou === true,
    local,
  });
  return { step, local };
}

const groups = [
  { id: "you", label: "Needs you" },
  { id: "merge", label: "Ready to merge" },
  { id: "wait", label: "Waiting" },
  { id: "drafts", label: "Drafts" },
] as const;
export type PrStepGroup = (typeof groups)[number]["id"];

function groupOf(step: PrNextStep): PrStepGroup {
  if (prStepsForYou.includes(step)) return "you";
  if (step === "merge") return "merge";
  if (step === "draft") return "drafts";
  return "wait";
}

const newest = (a: ForgePrRow, b: ForgePrRow) => b.updatedAt.localeCompare(a.updatedAt);

/**
 * Rows grouped by step: Needs you in step order (answer first), then newest activity first;
 * every other group newest first. Empty groups are left out.
 */
export function groupBySteps(
  rows: readonly ForgePrRow[],
  stepOf: (row: ForgePrRow) => PrNextStep,
): RowGroup<ForgePrRow>[] {
  const urgency = (row: ForgePrRow) => prStepsForYou.indexOf(stepOf(row));
  return groups
    .map((group) => {
      const members = rows.filter((row) => groupOf(stepOf(row)) === group.id);
      return {
        id: group.id,
        label: group.label,
        rows: members.toSorted(
          group.id === "you" ? (a, b) => urgency(a) - urgency(b) || newest(a, b) : newest,
        ),
      };
    })
    .filter((group) => group.rows.length > 0);
}

/** The quiet word a row waiting on someone else shows; none when nothing more is known. */
export function waitingWord(row: ForgePrRow, local: LocalCheckResult): string | undefined {
  if (row.ci === "pending" || local === "running") return "Checks running";
  if (row.reviewDecision === "REVIEW_REQUIRED") return "Waiting on review";
  return undefined;
}

/** The request handed to an agent for a step it can take on: what to do, about which PR. */
export function agentRequest(
  step: PrNextStep,
  row: Pick<ForgePrRow, "ref" | "url" | "baseBranch" | "ci">,
  local: LocalCheckResult,
  command: string | null | undefined,
): string | undefined {
  const pr = `PR #${row.ref.number} (${row.url})`;
  const base = row.baseBranch ?? "its base branch";
  switch (step) {
    case "resolve":
      return `${pr} conflicts with ${base}. Merge ${base} into the PR branch, resolve the conflicts keeping both sides' intent, run the checks and push.`;
    case "fix": {
      const failing = [
        ...(row.ci === "failure" ? ["its GitHub checks"] : []),
        ...(local === "failed"
          ? [command ? `the local check \`${command}\`` : "the local check"]
          : []),
      ];
      const what = failing.join(" and ") || "its checks";
      return `${what.charAt(0).toUpperCase()}${what.slice(1)} fail on ${pr}. Read the failures, find the cause and push a fix to the PR branch.`;
    }
    case "address":
      return `Changes were requested on ${pr}. Read the review comments, make the changes, push them and reply on each thread.`;
    default:
      return undefined;
  }
}
