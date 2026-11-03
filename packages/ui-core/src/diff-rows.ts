import { splitLines, type DiffLine, type DiffRow } from "./diff.ts";

/*
 * Changes to a patch's rows after they are built. Pure: the hunks stay the host's, so comments
 * anchor where the host expects them.
 */

type Fold = Extract<DiffRow, { kind: "fold" }>;

/**
 * A patch's folds with their lines, read from the new side's whole text: each fold opens like
 * one diffed from both texts, and the unchanged lines after the last hunk become one more fold.
 * The rows before them keep their places, so a fold's index still names the same fold. A fold
 * whose lines the text doesn't hold stays as it was.
 */
export function fillFolds(rows: readonly DiffRow[], newText: string): DiffRow[] {
  const text = splitLines(newText);
  const out: DiffRow[] = [];
  let lastOld = 0;
  let lastNew = 0;
  const filled = (fold: Fold, count: number): DiffRow => {
    if (fold.lines || count <= 0 || lastNew + count > text.length) return fold;
    const lines: DiffLine[] = [];
    for (let at = 1; at <= count; at++)
      lines.push({
        kind: "context",
        old: lastOld + at,
        new: lastNew + at,
        text: text[lastNew + at - 1] ?? "",
      });
    return { kind: "fold", count, lines };
  };
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row) continue;
    if (row.kind !== "fold") {
      if (row.old !== undefined) lastOld = row.old;
      if (row.new !== undefined) lastNew = row.new;
      out.push(row);
      continue;
    }
    // The unchanged lines run up to the next line the patch shows, on either side.
    const next = rows.slice(index + 1).find((r): r is DiffLine => r.kind !== "fold");
    const count =
      next?.old !== undefined
        ? next.old - lastOld - 1
        : next?.new !== undefined
          ? next.new - lastNew - 1
          : text.length - lastNew;
    out.push(filled(row, count));
  }
  const rest = text.length - lastNew;
  if (rows.length && rows.at(-1)?.kind !== "fold" && rest > 0)
    out.push(filled({ kind: "fold", count: rest }, rest));
  return out;
}

/** Past this many line pairs in one change, its whitespace is left as it is. */
const maxPairs = 40_000;
const bare = (text: string) => text.replace(/\s+/g, "");

/**
 * Rows with changes that only touch whitespace read as unchanged: within each run of removed and
 * added lines, a removed line and an added line that match once spaces are dropped become one
 * unchanged line (the new text, both numbers), in the order of a longest match.
 */
export function hideWhitespace(rows: readonly DiffRow[]): DiffRow[] {
  const out: DiffRow[] = [];
  let run: DiffLine[] = [];
  const flush = () => {
    if (run.length) out.push(...withoutWhitespace(run));
    run = [];
  };
  for (const row of rows) {
    if (row.kind === "add" || row.kind === "del") run.push(row);
    else {
      flush();
      out.push(row);
    }
  }
  flush();
  return out;
}

function withoutWhitespace(run: readonly DiffLine[]): DiffLine[] {
  const dels = run.filter((line) => line.kind === "del");
  const adds = run.filter((line) => line.kind === "add");
  const n = dels.length;
  const m = adds.length;
  if (!n || !m || n * m > maxPairs) return [...run];
  const a = dels.map((line) => bare(line.text));
  const b = adds.map((line) => bare(line.text));
  const width = m + 1;
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lengths[i * width + j] =
        a[i] === b[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
  if (!lengths[0]) return [...run];
  const out: DiffLine[] = [];
  const pending: DiffLine[] = [];
  let i = 0;
  let j = 0;
  // Removals before additions between matches, as a unified diff orders them.
  const settle = () => {
    out.push(...pending.filter((line) => line.kind === "del"));
    out.push(...pending.filter((line) => line.kind === "add"));
    pending.length = 0;
  };
  while (i < n || j < m) {
    const del = dels[i];
    const add = adds[j];
    if (del && add && a[i] === b[j]) {
      settle();
      out.push({ kind: "context", old: del.old, new: add.new, text: add.text });
      i++;
      j++;
    } else if (del && (!add || (lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0))) {
      pending.push(del);
      i++;
    } else if (add) {
      pending.push(add);
      j++;
    }
  }
  settle();
  return out;
}
