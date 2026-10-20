import type { ForgePrStatus, GitStatusFile, ThreadDetails } from "@ace/protocol";
import { checkoutNote, checkoutOf, nextGitStep } from "./checkout.ts";
import { readDiffText } from "./diff.ts";
import { patchSections } from "./git-patch.ts";
import { ciLine, mergeGate, mergeMethods } from "./pull-request.ts";

/*
 * The native apps' Changes sheet (issue #560, item 6): the files a thread changed in its
 * checkout with their line counts, one file's unified diff at a time within a fixed budget, and
 * the next step towards a merged change. Pure: callers pass what the daemon's `git.status`,
 * `git.diff` and `pr.status` reads answered and the thread's live details.
 */

export interface ChangeFileRow {
  path: string;
  /** A rename's old path. */
  from: string | null;
  status: GitStatusFile["status"];
  additions: number;
  deletions: number;
  binary: boolean;
}
export interface ChangesSummary {
  files: ChangeFileRow[];
  /** Files beyond the list's cap, or beyond what one `git.status` read returns. */
  hidden: number;
  /** The daemon reported more files than one read returns: the totals are a lower bound. */
  partial: boolean;
  totals: { files: number; additions: number; deletions: number };
}

export function changesSummary(
  files: readonly GitStatusFile[],
  truncated: boolean,
  limit = 200,
): ChangesSummary {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return {
    files: files.slice(0, limit).map((file) => ({
      path: file.path,
      from: file.from ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
    })),
    hidden: Math.max(0, files.length - limit),
    partial: truncated,
    totals: { files: files.length, additions, deletions },
  };
}

/**
 * A `git diff` patch split by file: each path (the new one, or the old one for a deletion) to
 * its own section. Sections are slices of the patch, so this holds no more than the patch does.
 */
export function patchFiles(patch: string): Map<string, string> {
  return new Map(patchSections(patch).map((section) => [section.path, section.text]));
}

export interface MobileDiffLine {
  kind: "add" | "del" | "context" | "hunk";
  old: number | null;
  new: number | null;
  text: string;
  /** The line was longer than the view keeps; the rest is on the computer. */
  clipped: boolean;
}
export interface MobileFileDiff {
  lines: MobileDiffLine[];
  /** Diff lines past the budget. */
  hiddenLines: number;
  /** Something of this file's diff isn't shown: past the budget, or past the daemon's cap. */
  truncated: boolean;
  /** Git reported no line changes it can show (a binary file, a mode change, an untracked file). */
  empty: boolean;
}
export interface DiffBudget {
  lines: number;
  /** UTF-16 code units kept of one line. */
  lineLength: number;
  /** UTF-16 code units of text across the whole file. */
  text: number;
}
export const mobileDiffBudget: DiffBudget = { lines: 1500, lineLength: 1000, text: 96_000 };

/** Keep `limit` code units without splitting a surrogate pair. Native callers can do better. */
export function clipText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const code = text.charCodeAt(limit - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit);
}

/**
 * One file's section as numbered lines within the budget. `sourceTruncated` says the daemon
 * cut the patch, so the last file's section may be incomplete.
 */
export function mobileFileDiff(
  section: string | undefined,
  sourceTruncated: boolean,
  budget: DiffBudget = mobileDiffBudget,
  clip: (text: string, limit: number) => string = clipText,
): MobileFileDiff {
  const read = readDiffText(section ?? "");
  const lines: MobileDiffLine[] = [];
  let text = 0;
  let hiddenLines = 0;
  // A trailing empty context line is the patch's final newline, not a line of the file.
  const tail = read.lines.at(-1);
  const rows = tail?.kind === "context" && tail.text === "" ? read.lines.slice(0, -1) : read.lines;
  for (const line of rows) {
    if (line.kind === "meta") continue;
    if (lines.length >= budget.lines || text >= budget.text) {
      hiddenLines++;
      continue;
    }
    // Strip the +/-/space marker: the kind carries it, and colour shows it.
    const body = line.kind === "hunk" ? line.text : line.text.slice(1);
    const limit = Math.min(budget.lineLength, budget.text - text);
    // Every line goes through `clip`: a native one also repairs ill-formed text.
    const kept = clip(body, limit);
    text += Math.min(body.length, limit);
    lines.push({
      kind: line.kind,
      old: line.old ?? null,
      new: line.new ?? null,
      text: kept,
      clipped: body.length > limit,
    });
  }
  return {
    lines,
    hiddenLines,
    truncated: hiddenLines > 0 || sourceTruncated || lines.some((line) => line.clipped),
    empty: !lines.some((line) => line.kind !== "hunk"),
  };
}

export type ChangesStepKind = "commit" | "push" | "create-pr" | "merge" | "none";
export interface ChangesStep {
  kind: ChangesStepKind;
  label: string;
  /** One quiet line under it: what the step takes, or the PR's checks. */
  detail: string;
  /** Why the step can't run now, in words. */
  blocked: string | null;
  pr: { number: number; url: string | null; state: string; title: string | null } | null;
}

/**
 * The next step the web's git action offers, from the same rules: commit what is uncommitted,
 * push what the remote lacks, open a PR, then merge the open one when the forge allows it.
 * `changed` is the fresh `git.status` file count, which wins over the details' last refresh.
 */
export function changesNextStep(
  details: ThreadDetails | undefined,
  status: ForgePrStatus | null | undefined,
  changed?: { files: number; additions: number; deletions: number },
): ChangesStep {
  const read = checkoutOf(details, status);
  if (!read)
    return {
      kind: "none",
      label: "No git checkout",
      detail: "This thread's folder isn't a git checkout.",
      blocked: "Nothing to commit",
      pr: null,
    };
  const checkout = changed
    ? {
        ...read,
        changed: changed.files,
        additions: changed.additions,
        deletions: changed.deletions,
      }
    : read;
  const step = nextGitStep(checkout);
  const files = `${checkout.changed} ${checkout.changed === 1 ? "file" : "files"}`;
  if (step.kind === "commit")
    return {
      kind: "commit",
      label: "Commit & push",
      detail: `${files} · +${checkout.additions} −${checkout.deletions}`,
      blocked: checkout.branch ? null : "The checkout is on a detached HEAD.",
      pr: null,
    };
  if (step.kind === "push")
    return {
      kind: "push",
      label: "Push",
      detail: checkoutNote(checkout) ?? "Commits not pushed",
      blocked: null,
      pr: null,
    };
  if (step.kind === "create-pr")
    return {
      kind: "create-pr",
      label: "Create PR",
      detail: checkout.branch ? `From ${checkout.branch}` : "",
      blocked: step.blocked ?? null,
      pr: null,
    };
  const pr = {
    number: step.pr.number,
    url: step.pr.url ?? status?.url ?? null,
    state: step.pr.state,
    title: step.pr.title ?? null,
  };
  // Only the forge's own status can say a merge may run; without it, ask for a refresh.
  const same = status && status.ref.number === step.pr.number;
  return {
    kind: "merge",
    label: mergeMethods[0]?.label ?? "Merge",
    detail: same ? ciLine(status).text : `PR #${pr.number}`,
    blocked: same
      ? (mergeGate(status, checkout.baseBranch) ?? null)
      : "GitHub hasn't reported this PR yet: refresh, then retry",
    pr,
  };
}
