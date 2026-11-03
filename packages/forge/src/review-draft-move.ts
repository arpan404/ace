import {
  maxDraftCodeLines,
  type ForgeReviewAnchor,
  type ForgeReviewDraft,
} from "@ace/protocol/forge-review";
import { validHostedAnchor } from "./review-anchor.ts";

/*
 * Where a pending draft goes when the pull request's head moves. Pure: the shell reads GitHub's
 * comparison of the draft's commit with the new head, and the PR's patch at the new head.
 */

/** One file of GitHub's comparison of two commits. */
export type ComparedFile = {
  path: string;
  previousPath?: string | undefined;
  status: string;
  patch?: string | undefined;
};

/** GitHub's comparison of the commit a draft was written on with the new head. */
export type Comparison = {
  /** The new head descends from the draft's commit: the comparison describes every change. */
  descends: boolean;
  /** A commit since merges another branch, so the base the PR's left side shows may differ. */
  merges: boolean;
  /** Every changed file is listed; GitHub caps the list. */
  complete: boolean;
  files: readonly ComparedFile[];
};

export type DraftMove =
  | { kind: "moved"; anchor: ForgeReviewAnchor }
  | { kind: "outdated"; code: string[] };

type Row = { kind: "-" | "+" | " "; left?: number; right?: number; text: string };

/** A unified patch as rows, each knowing its old (left) and new (right) line. */
export function patchRows(patch: string): { rows: Row[]; insertAfter: Map<Row, number> } {
  const rows: Row[] = [];
  const insertAfter = new Map<Row, number>();
  let left = 0,
    right = 0,
    last = 0,
    active = false;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      left = Number(hunk[1]);
      right = Number(hunk[3]);
      // With no old lines, the start names the line the new ones follow.
      last = hunk[2] === "0" ? left : left - 1;
      active = true;
      continue;
    }
    if (!active || text.startsWith("\\")) continue;
    const kind = text[0];
    if (kind === "-") {
      rows.push({ kind, left, text: text.slice(1) });
      last = left++;
    } else if (kind === "+") {
      const row: Row = { kind, right: right++, text: text.slice(1) };
      insertAfter.set(row, last);
      rows.push(row);
    } else if (kind === " ") {
      rows.push({ kind, left, right: right++, text: text.slice(1) });
      last = left++;
    }
  }
  return { rows, insertAfter };
}

/**
 * Lines `start`..`end` of the old file in the new one, or null when the patch changed them:
 * a line removed or replaced, or a line added between two of them.
 */
export function followLines(
  patch: string,
  start: number,
  end: number,
): { start: number; end: number } | null {
  const { rows, insertAfter } = patchRows(patch);
  let shift = 0;
  for (const row of rows) {
    if (row.kind === "-" && row.left !== undefined) {
      if (row.left >= start && row.left <= end) return null;
      if (row.left < start) shift--;
    } else if (row.kind === "+") {
      const after = insertAfter.get(row) ?? 0;
      if (after >= start && after < end) return null;
      if (after < start) shift++;
    }
  }
  return { start: start + shift, end: end + shift };
}

/** What lines `start`..`end` of one side said, from a patch that shows them. */
function linesFrom(patch: string | undefined, side: "LEFT" | "RIGHT", start: number, end: number) {
  if (!patch) return new Map<number, string>();
  const found = new Map<number, string>();
  for (const row of patchRows(patch).rows) {
    const line = side === "LEFT" ? row.left : row.right;
    if (line !== undefined && line >= start && line <= end) found.set(line, row.text);
  }
  return found;
}

/**
 * The code a draft was written on, oldest line first, ending at its line: from the comparison's
 * old side, else the PR's patch, else the whole old file the shell read. Missing lines are left
 * out rather than guessed.
 */
export function draftCode(
  anchor: ForgeReviewAnchor,
  sources: { compared?: string | undefined; hosted?: string | undefined; file?: readonly string[] },
): string[] {
  // A few lines above the draft's own, as GitHub's hunks show them.
  const start = Math.max(
    1,
    (anchor.startLine ?? anchor.line) - 3,
    anchor.line - maxDraftCodeLines + 1,
  );
  const compared =
    anchor.side === "RIGHT"
      ? // The comparison's left side is the draft's commit.
        linesFrom(sources.compared, "LEFT", start, anchor.line)
      : new Map<number, string>();
  const hosted = linesFrom(sources.hosted, anchor.side, start, anchor.line);
  const code: string[] = [];
  for (let line = start; line <= anchor.line; line++) {
    const text =
      compared.get(line) ??
      hosted.get(line) ??
      (anchor.side === "RIGHT" ? sources.file?.[line - 1] : undefined);
    if (text !== undefined) code.push(text);
  }
  return code;
}

/**
 * Where a draft written on an earlier commit goes at `headSha`. It moves only when nothing
 * since changed its lines and GitHub's patch at the head still draws them; otherwise it stays
 * where it was written, outdated, keeping its code. Unknown is outdated, never a guess.
 */
export function moveDraft(
  draft: ForgeReviewDraft,
  headSha: string,
  comparison: Comparison,
  hosted: readonly { path: string; patch?: string | undefined }[],
  file?: readonly string[],
): DraftMove {
  const { anchor } = draft;
  const changed = comparison.files.find(
    (f) => f.path === anchor.path || f.previousPath === anchor.path,
  );
  const outdated = (): DraftMove => ({
    kind: "outdated",
    code: draftCode(anchor, {
      compared: changed?.patch,
      hosted:
        anchor.side === "LEFT" ? hosted.find((f) => f.path === anchor.path)?.patch : undefined,
      ...(file ? { file } : {}),
    }),
  });
  if (!comparison.descends) return outdated();
  if (!changed && !comparison.complete) return outdated();
  if (changed?.status === "removed") return outdated();
  const path = changed?.path ?? anchor.path;
  const start = anchor.startLine ?? anchor.line;
  let lines: { start: number; end: number } | null = { start, end: anchor.line };
  if (anchor.side === "LEFT") {
    // The left side is the PR's base, which head commits don't change unless one merges it in.
    if (comparison.merges) return outdated();
  } else if (changed && (changed.patch !== undefined || changed.status !== "renamed")) {
    // A changed file without a patch (binary, or too large) can't show its lines survived.
    if (changed.patch === undefined) return outdated();
    lines = followLines(changed.patch, start, anchor.line);
  }
  if (!lines) return outdated();
  const next: ForgeReviewAnchor = {
    commit: headSha,
    path,
    line: lines.end,
    side: anchor.side,
    ...(anchor.startLine === undefined ? {} : { startLine: lines.start }),
    ...(anchor.startSide === undefined ? {} : { startSide: anchor.startSide }),
  };
  const patch = hosted.find((f) => f.path === path)?.patch;
  if (!patch || !validHostedAnchor(patch, next)) return outdated();
  return { kind: "moved", anchor: next };
}

/** The drafts a move at `headSha` would try: written on an earlier commit, not tried there. */
export function draftsToMove(
  drafts: readonly ForgeReviewDraft[],
  headSha: string,
): ForgeReviewDraft[] {
  return drafts.filter((d) => d.anchor.commit !== headSha && d.outdated?.headSha !== headSha);
}

/** A draft after its move: re-anchored, or kept where it was with its earlier code. */
export function movedDraft(
  draft: ForgeReviewDraft,
  move: DraftMove,
  headSha: string,
): ForgeReviewDraft {
  if (move.kind === "moved") return { id: draft.id, body: draft.body, anchor: move.anchor };
  // A later try that found less code keeps what an earlier one found.
  const code = move.code.length ? move.code : (draft.outdated?.code ?? []);
  return { ...draft, outdated: { headSha, code } };
}

/** The body an outdated draft posts with on its file: where it was, its code, then its text. */
export function fileCommentBody(draft: ForgeReviewDraft): string {
  const { anchor } = draft;
  const lines =
    anchor.startLine !== undefined && anchor.startLine !== anchor.line
      ? `lines ${anchor.startLine}–${anchor.line}`
      : `line ${anchor.line}`;
  const where = `On ${lines}${anchor.side === "LEFT" ? " (old side)" : ""} at ${anchor.commit.slice(0, 7)}:`;
  const code = draft.outdated?.code ?? [];
  const longest = Math.max(2, ...code.map((l) => /`+/.exec(l)?.[0].length ?? 0));
  const fence = "`".repeat(longest + 1);
  const quoted = code.length ? `\n\n${fence}\n${code.join("\n")}\n${fence}` : "";
  return `${where}${quoted}\n\n${draft.body}`;
}
