import {
  ReviewAnchor,
  ReviewFingerprint,
  ReviewPosition,
  type ReviewRevision,
} from "@ace/protocol";
import type { DiffResult } from "@ace/git";
import { readPatch, type Change, type PatchFile, type Hunk } from "./patch.ts";

export function anchorComment(
  diff: DiffResult,
  position: ReviewPosition,
  revision: ReviewRevision,
): ReviewAnchor {
  const anchor = anchorComments(diff, [position], revision, revision)[0];
  if (!anchor) throw new Error("review_lines_not_visible");
  return anchor;
}
export function anchorComments(
  diff: DiffResult,
  positions: readonly ReviewPosition[],
  from: ReviewRevision,
  to: ReviewRevision,
): ReviewAnchor[] {
  if (positions.length > 100) throw new Error("review_comment_limit");
  const files = readPatch(diff);
  const oldFiles = new Map(files.map((file) => [file.oldPath, file]));
  const newFiles = new Map(files.map((file) => [file.path, file]));
  return positions.map((input) => {
    const position = ReviewPosition.parse(input);
    const file = (position.side === "old" ? oldFiles : newFiles).get(position.file);
    const hunk = file && findHunk(file.hunks, position.start, position.end, position.side);
    if (!hunk) throw new Error("review_lines_not_visible");
    const start = position.side === "old" ? hunk.oldStart : hunk.newStart;
    const lines = position.side === "old" ? hunk.oldLines : hunk.newLines;
    return ReviewAnchor.parse({
      position,
      revision: position.side === "old" ? from : to,
      state: "active",
      fingerprint: fingerprint(lines, position.start - start, position.end - position.start + 1),
    });
  });
}
function findHunk(
  hunks: Hunk[],
  start: number,
  end: number,
  side: "old" | "new",
): Hunk | undefined {
  let lo = 0;
  let hi = hunks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const hunk = hunks[mid];
    if (hunk && (side === "old" ? hunk.oldStart : hunk.newStart) <= start) lo = mid + 1;
    else hi = mid;
  }
  const hunk = hunks[lo - 1];
  if (!hunk) return undefined;
  const first = side === "old" ? hunk.oldStart : hunk.newStart;
  const lines = side === "old" ? hunk.oldLines : hunk.newLines;
  return end < first + lines.length ? hunk : undefined;
}
function fingerprint(lines: string[], offset: number, count: number): ReviewFingerprint {
  return ReviewFingerprint.parse({
    before: lines.slice(Math.max(0, offset - 3), offset),
    lines: lines.slice(offset, offset + count),
    after: lines.slice(offset + count, offset + count + 3),
  });
}
const normalize = (line: string) => line.trim().replace(/\s+/g, " ");
interface Index {
  file: PatchFile;
  changes: Change[];
  lines: Map<number, string>;
  postings: Map<string, number[]>;
  addedLines: Set<number>;
}
function indexFile(file: PatchFile): Index {
  const lines = new Map<number, string>();
  const postings = new Map<string, number[]>();
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedLines = new Set<number>();
  for (const change of changes)
    for (let offset = 0; offset < change.newCount; offset++)
      addedLines.add(change.newStart + offset);
  for (const hunk of file.hunks)
    for (const [offset, text] of hunk.newLines.entries()) {
      const number = hunk.newStart + offset;
      lines.set(number, text);
      const key = normalize(text);
      const list = postings.get(key) ?? [];
      // 65 means ambiguous beyond the 64-candidate admission cap.
      if (list.length < 65) list.push(number);
      postings.set(key, list);
    }
  return { file, lines, postings, changes, addedLines };
}
function mapLine(changes: Change[], line: number): { line?: number; replacement: boolean } {
  let lo = 0;
  let hi = changes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const change = changes[mid];
    if (change && change.oldStart <= line) lo = mid + 1;
    else hi = mid;
  }
  const change = changes[lo - 1];
  if (!change) return { line, replacement: false };
  if (line < change.oldStart + change.oldCount) return { replacement: change.newCount > 0 };
  return {
    line: line + change.newStart + change.newCount - change.oldStart - change.oldCount,
    replacement: false,
  };
}
function touches(changes: Change[], start: number, end: number): boolean {
  let lo = 0;
  let hi = changes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const change = changes[mid];
    if (change && change.oldStart <= end) lo = mid + 1;
    else hi = mid;
  }
  const change = changes[lo - 1];
  return (
    change !== undefined &&
    (change.oldCount > 0 ? change.oldStart + change.oldCount > start : change.oldStart > start)
  );
}
function similarity(a: string, b: string): number {
  if (normalize(a) === normalize(b)) return 1;
  const left = new Set(a.match(/[\w]+|[^\s\w]/g) ?? []);
  const right = new Set(b.match(/[\w]+|[^\s\w]/g) ?? []);
  let common = 0;
  for (const token of left) if (right.has(token)) common++;
  return left.size + right.size ? (2 * common) / (left.size + right.size) : 0;
}
function locate(index: Index, anchor: ReviewAnchor, allowFuzzy: boolean): number | undefined {
  const f = anchor.fingerprint;
  const candidates = new Set<number>();
  const add = (text: string, offset: number) => {
    if (candidates.size > 64) return;
    const list = index.postings.get(normalize(text));
    if (list && list.length <= 64)
      for (const number of list) {
        const start = number - offset;
        // Unchanged duplicates are not evidence that a deleted selection moved.
        if (start > 0 && f.lines.some((_, lineOffset) => index.addedLines.has(start + lineOffset)))
          candidates.add(start);
        if (candidates.size > 64) break;
      }
  };
  if (f.lines[0] !== undefined) add(f.lines[0], 0);
  if (allowFuzzy) {
    f.before.forEach((line, offset) => add(line, offset - f.before.length));
    f.after.forEach((line, offset) => add(line, f.lines.length + offset));
  }
  if (candidates.size > 64) return undefined;
  const exact = [...candidates].filter((start) =>
    f.lines.every((line, offset) => index.lines.get(start + offset) === line),
  );
  if (exact.length === 1) return exact[0];
  if (!allowFuzzy || exact.length > 1) return undefined;
  let best: number | undefined;
  let bestScore = 0.8;
  let tied = false;
  for (const start of candidates) {
    const selected =
      f.lines
        .map((line, offset) => similarity(line, index.lines.get(start + offset) ?? ""))
        .reduce((a, b) => a + b, 0) / f.lines.length;
    const context = [
      ...f.before.map((line, offset) =>
        similarity(line, index.lines.get(start + offset - f.before.length) ?? ""),
      ),
      ...f.after.map((line, offset) =>
        similarity(line, index.lines.get(start + f.lines.length + offset) ?? ""),
      ),
    ];
    if (!context.length || selected < 0.5) continue;
    const score = selected * 0.5 + (context.reduce((a, b) => a + b, 0) / context.length) * 0.5;
    if (score > bestScore) {
      best = start;
      bestScore = score;
      tied = false;
    } else if (score === bestScore) tied = true;
  }
  return tied ? undefined : best;
}

function mappedFingerprint(
  index: Index,
  anchor: ReviewAnchor,
  start: number,
  end: number,
): ReviewFingerprint | undefined {
  const f = anchor.fingerprint;
  if (
    anchor.state !== "outdated" &&
    !touches(
      index.changes,
      anchor.position.start - f.before.length,
      anchor.position.end + f.after.length,
    )
  )
    return f;
  const known = new Map<number, string>();
  if (anchor.state !== "outdated") {
    const remember = (lines: string[], first: number) =>
      lines.forEach((text, offset) => {
        const mapped = mapLine(index.changes, first + offset).line;
        if (mapped !== undefined) known.set(mapped, text);
      });
    remember(f.before, anchor.position.start - f.before.length);
    remember(f.lines, anchor.position.start);
    remember(f.after, anchor.position.end + 1);
  }
  const read = (line: number) => index.lines.get(line) ?? known.get(line);
  const lines: string[] = [];
  for (let line = start; line <= end; line++) {
    const text = read(line);
    if (text === undefined) return undefined;
    lines.push(text);
  }
  const before: string[] = [];
  const after: string[] = [];
  for (let line = start - 1; line > 0 && line >= start - 3; line--) {
    const text = read(line);
    if (text === undefined) break;
    before.unshift(text);
  }
  for (let line = end + 1; line <= end + 3; line++) {
    const text = read(line);
    if (text === undefined) break;
    after.push(text);
  }
  return ReviewFingerprint.parse({ before, lines, after });
}

/** Transition is the old revision → new revision of the anchor's own side. */
export function reanchorComments(
  anchors: readonly ReviewAnchor[],
  transition: DiffResult,
  revision: ReviewRevision,
): ReviewAnchor[] {
  if (anchors.length > 1000) throw new Error("review_comment_limit");
  const files = new Map(readPatch(transition).map((file) => [file.oldPath, indexFile(file)]));
  return anchors.map((input) => {
    const anchor = ReviewAnchor.parse(input);
    const index = files.get(anchor.position.file);
    if (!index) return anchor.state === "outdated" ? anchor : { ...anchor, revision };
    if (index.file.unavailable) return { ...anchor, state: "outdated" };
    const first = mapLine(index.changes, anchor.position.start);
    const last = mapLine(index.changes, anchor.position.end);
    let start = first.line;
    let end = last.line;
    const changed = touches(index.changes, anchor.position.start, anchor.position.end);
    if (start === undefined || end === undefined || anchor.state === "outdated") {
      start = locate(index, anchor, first.replacement || last.replacement);
      end = start === undefined ? undefined : start + anchor.fingerprint.lines.length - 1;
    }
    if (start === undefined || end === undefined || end < start || end - start >= 100)
      return { ...anchor, state: "outdated" };
    const position = { ...anchor.position, file: index.file.path, start, end };
    const available = findHunk(index.file.hunks, start, end, "new");
    const f = available
      ? fingerprint(available.newLines, start - available.newStart, end - start + 1)
      : mappedFingerprint(index, anchor, start, end);
    if (!f) return { ...anchor, state: "outdated" };
    return ReviewAnchor.parse({
      ...anchor,
      position,
      revision,
      fingerprint: f,
      state: changed
        ? "addressed-pending-review"
        : anchor.state === "outdated"
          ? "active"
          : anchor.state,
    });
  });
}
