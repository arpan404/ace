/**
 * Turn file changes into rows for the diff view. Pure. Two inputs: full before/after text
 * (diffed here, so every unchanged run can be folded and expanded) or a provider's unified
 * diff (whose gaps between hunks are known only by size).
 */
export interface DiffLine {
  kind: "context" | "add" | "del";
  /** Line numbers on the old and new side; absent on the side the line does not exist. */
  old?: number;
  new?: number;
  text: string;
}
export type DiffRow =
  | DiffLine
  | {
      kind: "fold";
      /** Unchanged lines hidden here; null when the size is unknown (end of a patch). */
      count: number | null;
      /** The hidden lines, when known, so the fold can expand. */
      lines?: DiffLine[];
    };

const contextLines = 3;
/** Above this many cells the middle of a file is shown as replaced rather than diffed. */
const maxCells = 4_000_000;

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Line diff of two texts: common prefix and suffix, then an LCS of the middle. */
export function diffTexts(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++)
    out.push({ kind: "context", old: i + 1, new: i + 1, text: a[i] ?? "" });
  middle(a.slice(head, a.length - tail), b.slice(head, b.length - tail), head, head, out);
  for (let i = tail; i > 0; i--) {
    const oldIndex = a.length - i;
    const newIndex = b.length - i;
    out.push({ kind: "context", old: oldIndex + 1, new: newIndex + 1, text: a[oldIndex] ?? "" });
  }
  return out;
}

function middle(a: string[], b: string[], oldBase: number, newBase: number, out: DiffLine[]) {
  const n = a.length;
  const m = b.length;
  if (n * m > maxCells) {
    a.forEach((text, i) => out.push({ kind: "del", old: oldBase + i + 1, text }));
    b.forEach((text, j) => out.push({ kind: "add", new: newBase + j + 1, text }));
    return;
  }
  // lengths[i][j] = LCS of a[i..] and b[j..], flattened.
  const width = m + 1;
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lengths[i * width + j] =
        a[i] === b[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: "context", old: oldBase + i + 1, new: newBase + j + 1, text: a[i] ?? "" });
      i++;
      j++;
    } else if (
      j < m &&
      (i >= n || (lengths[i * width + j + 1] ?? 0) >= (lengths[(i + 1) * width + j] ?? 0))
    ) {
      out.push({ kind: "add", new: newBase + j + 1, text: b[j] ?? "" });
      j++;
    } else {
      out.push({ kind: "del", old: oldBase + i + 1, text: a[i] ?? "" });
      i++;
    }
  }
}

/** Hide unchanged runs longer than the context around changes behind expandable folds. */
export function fold(lines: readonly DiffLine[], context = contextLines): DiffRow[] {
  const rows: DiffRow[] = [];
  let run: DiffLine[] = [];
  const flush = (atStart: boolean, atEnd: boolean) => {
    const keepBefore = atStart ? 0 : context;
    const keepAfter = atEnd ? 0 : context;
    if (run.length > keepBefore + keepAfter + 1) {
      rows.push(...run.slice(0, keepBefore));
      const hidden = run.slice(keepBefore, run.length - keepAfter);
      rows.push({ kind: "fold", count: hidden.length, lines: hidden });
      rows.push(...run.slice(run.length - keepAfter));
    } else rows.push(...run);
    run = [];
  };
  let first = true;
  for (const line of lines) {
    if (line.kind === "context") {
      run.push(line);
      continue;
    }
    flush(first, false);
    first = false;
    rows.push(line);
  }
  if (first) return lines.length ? [{ kind: "fold", count: lines.length, lines: [...lines] }] : [];
  flush(false, true);
  return rows;
}

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Rows for a unified diff. Unknown gaps between hunks become folds of known size. */
export function parseUnifiedDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  // Lines left in the current hunk on each side; the header's counts bound it.
  let oldLeft = 0;
  let newLeft = 0;
  let nextOld = 1;
  for (const raw of text.split("\n")) {
    const header = hunkHeader.exec(raw);
    if (header) {
      const start = Number(header[1]);
      if (start > nextOld) rows.push({ kind: "fold", count: start - nextOld });
      oldLine = start;
      newLine = Number(header[3]);
      oldLeft = Number(header[2] ?? 1);
      newLeft = Number(header[4] ?? 1);
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) continue;
    const mark = raw[0];
    const body = raw.slice(1);
    if (mark === "+") {
      rows.push({ kind: "add", new: newLine++, text: body });
      newLeft--;
    } else if (mark === "-") {
      rows.push({ kind: "del", old: oldLine++, text: body });
      oldLeft--;
    } else if (mark === " " || raw === "") {
      rows.push({ kind: "context", old: oldLine++, new: newLine++, text: body });
      oldLeft--;
      newLeft--;
    }
    nextOld = oldLine;
  }
  return rows;
}

export function countChanges(rows: readonly DiffRow[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const row of rows) {
    if (row.kind === "add") additions++;
    else if (row.kind === "del") deletions++;
  }
  return { additions, deletions };
}

/** Side-by-side pairs: deletions and additions of one change line up row by row. */
export type SplitRow =
  | { kind: "fold"; row: Extract<DiffRow, { kind: "fold" }> }
  | { kind: "pair"; left?: DiffLine; right?: DiffLine };
export function pairRows(rows: readonly DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const left = dels[i];
      const right = adds[i];
      out.push({ kind: "pair", ...(left ? { left } : {}), ...(right ? { right } : {}) });
    }
    dels = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.kind === "del") {
      if (adds.length) flush();
      dels.push(row);
    } else if (row.kind === "add") adds.push(row);
    else {
      flush();
      out.push(
        row.kind === "fold" ? { kind: "fold", row } : { kind: "pair", left: row, right: row },
      );
    }
  }
  flush();
  return out;
}
