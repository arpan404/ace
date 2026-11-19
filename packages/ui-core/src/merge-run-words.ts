import { verifyMergeLimit, verifySettled, type VerifyResult, type VerifyRun } from "@ace/protocol";

/*
 * The merge strip in words (ADR 0094), shared by the web's Pull requests list and the phone's:
 * what picking ready pull requests offers, one sentence for a merge run's progress or ending,
 * the text actions it offers, and which run the strip shows. Pure.
 */

export type StripAction =
  | { kind: "stop"; label: "Stop" }
  | { kind: "dismiss"; label: "Dismiss" }
  | { kind: "again"; label: "Verify again" }
  | { kind: "without"; label: string; pr: number }
  | { kind: "log"; label: "Show log" }
  | { kind: "open"; label: string; pr: number }
  | { kind: "command"; label: "Set a check command" };

export interface RunWords {
  sentence: string;
  /** Live runs show how long they have run, from this moment. */
  since?: number | undefined;
  actions: StripAction[];
}

/** "a", "a and b", "a, b and c". */
function listed(words: readonly string[]): string {
  if (words.length < 2) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** "#1219", "#1219 and #1221", "#1219, #1221 and #1197". */
export const prNumbers = (prs: readonly number[]) => listed(prs.map((pr) => `#${pr}`));

export const pullRequestCount = (count: number) => `${count} pull request${count === 1 ? "" : "s"}`;

const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const stop = { kind: "stop", label: "Stop" } as const;
const dismiss = { kind: "dismiss", label: "Dismiss" } as const;
const again = { kind: "again", label: "Verify again" } as const;
const log = { kind: "log", label: "Show log" } as const;

/** What a live run is doing now, in one sentence. */
function progress(run: VerifyRun, prs: readonly number[], base: string): string {
  if (run.state === "queued") return "Waiting for this project's earlier run";
  const step = run.steps.find((each) => each.state === "running");
  const together = prs.length > 1 ? `${prNumbers(prs)} together` : prNumbers(prs);
  switch (step?.kind) {
    case "fetch":
      return `Fetching ${listed([base, ...prs.map((pr) => `#${pr}`)])}`;
    case "combine":
      return `Combining #${step.pr} onto ${base}`;
    case "setup":
      return `Setting up ${together} on ${base}`;
    case "merge": {
      const at = step.pr === undefined ? -1 : prs.indexOf(step.pr);
      return `Merging #${step.pr} into ${base}, ${at + 1} of ${prs.length}`;
    }
    default:
      return `Checking ${together} on ${base}`;
  }
}

/** Some merged, some not: what did. */
const mergedPart = (merged: readonly number[]) =>
  merged.length ? `merged ${prNumbers(merged)}` : "nothing was merged";

/** How a settled run ended, and what the person can do next. */
function ending(run: VerifyRun, prs: readonly number[], base: string): RunWords {
  if (run.state === "merged")
    return { sentence: `Merged ${pullRequestCount(run.merged.length)}`, actions: [dismiss] };
  if (run.state === "cancelled")
    return { sentence: "Stopped; nothing was merged", actions: [dismiss] };
  if (run.state === "interrupted")
    return {
      sentence: "ace restarted before merging; nothing was merged",
      actions: [again, dismiss],
    };
  const failure = run.failure;
  const together = prs.length > 1 ? `${prNumbers(prs)} together` : prNumbers(prs);
  switch (failure?.code) {
    case "conflict": {
      const pr = failure.pr;
      const sentence =
        failure.with !== undefined
          ? `#${pr} conflicts with #${failure.with}`
          : `#${pr} conflicts with ${base}`;
      const actions: StripAction[] =
        pr !== undefined && prs.length > 1
          ? [{ kind: "without", label: `Remove #${pr} and retry`, pr }, dismiss]
          : [dismiss];
      return { sentence, actions };
    }
    case "check_failed":
      return {
        sentence: `Checks failed on ${together}; nothing was merged`,
        actions: [log, again, dismiss],
      };
    case "setup_failed":
      return {
        sentence: `Setup failed on ${together}; nothing was merged`,
        actions: [log, again, dismiss],
      };
    case "base_moved":
      return {
        sentence: `${capital(base)} moved after the check passed; nothing was merged`,
        actions: [again, dismiss],
      };
    case "head_moved":
      return {
        sentence:
          failure.pr !== undefined
            ? `#${failure.pr} changed since it was picked; nothing was merged`
            : "A pull request changed since it was picked; nothing was merged",
        actions: [dismiss],
      };
    case "fetch_failed":
      return {
        sentence: "Couldn't fetch from GitHub; nothing was merged",
        actions: [again, dismiss],
      };
    case "merge_refused":
    case "merge_uncertain": {
      const pr = failure.pr;
      const what =
        failure.code === "merge_refused"
          ? `GitHub refused to merge #${pr}`
          : `Couldn't confirm #${pr} merged`;
      return {
        sentence: `${what}; ${mergedPart(run.merged)}`,
        actions:
          pr === undefined ? [dismiss] : [{ kind: "open", label: `Open #${pr}`, pr }, dismiss],
      };
    }
    case "no_command":
      return {
        sentence: "This project has no check command",
        actions: [{ kind: "command", label: "Set a check command" }, dismiss],
      };
    case "unavailable":
      return { sentence: "Verify isn't available on this machine", actions: [dismiss] };
    default:
      return {
        sentence: failure?.message ? `Verify stopped: ${failure.message}` : "Verify stopped",
        actions: [again, dismiss],
      };
  }
}

/** A merge run in one sentence and its actions: progress while live, its ending once settled. */
export function runWords(run: VerifyRun, fallbackBase: string): RunWords {
  const prs = run.target.kind === "merge" ? run.target.prs.map((pr) => pr.pr.number) : [];
  const base = run.base?.branch ?? fallbackBase;
  if (verifySettled.includes(run.state)) return ending(run, prs, base);
  return {
    sentence: progress(run, prs, base),
    since: run.startedAt ?? run.createdAt,
    // Once merging on GitHub has begun, it can't be stopped.
    actions: run.state === "merging" ? [] : [stop],
  };
}

/** The ways a merge run may merge, as the strip's menu words them. */
export const mergeRunMethods: readonly { value: "squash" | "merge" | "rebase"; label: string }[] = [
  { value: "squash", label: "Squash" },
  { value: "merge", label: "Merge commit" },
  { value: "rebase", label: "Rebase" },
];

/** "Verify and merge 3 pull requests into main": what the strip offers for the picked rows. */
export const mergePickWords = (count: number, base: string) =>
  `Verify and merge ${pullRequestCount(count)} into ${base}`;

/**
 * Why a ready row can't join the merge selection now, or undefined when it can: a run takes at
 * most `verifyMergeLimit` pull requests, all into one base.
 */
export function mergePickBlocked(input: {
  picked: boolean;
  /** How many are picked already. */
  count: number;
  /** The base of those picked; undefined when none is. */
  base: string | undefined;
  rowBase: string | undefined;
}): string | undefined {
  if (input.picked) return undefined;
  if (input.count >= verifyMergeLimit)
    return `At most ${verifyMergeLimit} pull requests merge at once`;
  if (input.base !== undefined && input.rowBase !== input.base)
    return `Pick pull requests into ${input.base}`;
  return undefined;
}

const settled = (run: VerifyRun) => verifySettled.includes(run.state);

/**
 * The merge run the strip shows: the newest live one not dismissed, or the ending of the one
 * started here until it is dismissed or a new selection begins (`picking`).
 */
export function shownMergeRun(
  runs: readonly VerifyRun[],
  state: { dismissed: ReadonlySet<string>; own: string | undefined; picking: boolean },
): VerifyRun | undefined {
  const run = runs.find(
    (each) =>
      each.target.kind === "merge" &&
      !state.dismissed.has(each.id) &&
      (!settled(each) || each.id === state.own),
  );
  return run && (!settled(run) || !state.picking) ? run : undefined;
}

const refusals: Partial<Record<NonNullable<VerifyResult["error"]>, string>> = {
  no_command: "This project has no check command.",
  busy: "Too many runs are waiting in this project. Try again once one ends.",
  forbidden: "This device can't start runs on this machine.",
  settled: "Merging on GitHub has begun, so it can't be stopped.",
};

/** Why Verify refused to start or stop a merge run, in a sentence. */
export const mergeRunRefusal = (code: VerifyResult["error"] | undefined) =>
  (code ? refusals[code] : undefined) ?? "Verify didn't answer. Try again.";

/** A row as picked for a merge run: the head the person saw is the one the run is pinned to. */
export interface MergePickHead {
  key: string;
  number: number;
  headSha: string;
}

/**
 * The picks still on show with the head they were picked at, in list order. A row that got new
 * commits since leaves the selection, named in `notice`, so a run never merges a head the person
 * didn't choose; a row that left the list leaves quietly. When `pruned`, `kept` is the selection
 * from then on: a dropped pick stays gone, even if its row comes back or its head moves back,
 * until the person picks it again.
 */
export function mergeSelection<Pick extends MergePickHead>(
  picked: readonly Pick[],
  rows: readonly { key: string; headSha?: string | undefined }[],
): { kept: Pick[]; moved: number[]; notice: string | undefined; pruned: boolean } {
  const byKey = new Map(picked.map((pick) => [pick.key, pick]));
  const kept: Pick[] = [];
  const moved: number[] = [];
  for (const row of rows) {
    const pick = byKey.get(row.key);
    if (!pick) continue;
    if (row.headSha === pick.headSha) kept.push(pick);
    else moved.push(pick.number);
  }
  const notice = !moved.length
    ? undefined
    : moved.length === 1
      ? `${prNumbers(moved)} has new commits since it was picked. Pick it again to merge it.`
      : `${prNumbers(moved)} have new commits since they were picked. Pick them again to merge them.`;
  return { kept, moved, notice, pruned: kept.length !== picked.length };
}

/**
 * Why Start can't send these picks now, or undefined when it can: one whose head moved since it
 * was picked, or whose row is no longer in the list, is picked again first.
 */
export function mergeStartRefusal(
  picked: readonly MergePickHead[],
  rows: readonly { key: string; headSha?: string | undefined }[],
): string | undefined {
  const selection = mergeSelection(picked, rows);
  if (selection.notice) return selection.notice;
  const kept = new Set(selection.kept.map((pick) => pick.key));
  const gone = picked.filter((pick) => !kept.has(pick.key)).map((pick) => pick.number);
  if (!gone.length) return undefined;
  return gone.length === 1
    ? `${prNumbers(gone)} is no longer in the list. Pick it again to merge it.`
    : `${prNumbers(gone)} are no longer in the list. Pick them again to merge them.`;
}
