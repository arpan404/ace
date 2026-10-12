/**
 * Turn file changes into rows for the diff view. Pure. Two inputs: full before/after text
 * (diffed here, so every unchanged run can be folded and expanded) or a provider's unified
 * diff (whose gaps between hunks are known only by size).
 */
export interface DiffLine {
  kind: "context" | "add" | "del";
  /** Line numbers on the old and new side; absent on the side the line does not exist. */
  old?: number | undefined;
  new?: number | undefined;
  text: string;
}
export type DiffRow =
  | DiffLine
  | {
      kind: "fold";
      /** Unchanged lines hidden here; null when the size is unknown (end of a patch). */
      count: number | null;
      /** The hidden lines, when known, so the fold can expand. */
      lines?: DiffLine[] | undefined;
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
      i < n &&
      (j >= m || (lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0))
    ) {
      // Removals before additions, as in a unified diff.
      out.push({ kind: "del", old: oldBase + i + 1, text: a[i] ?? "" });
      i++;
    } else {
      out.push({ kind: "add", new: newBase + j + 1, text: b[j] ?? "" });
      j++;
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

/** One line of a diff as written, for showing a diff someone wrote rather than one computed. */
export interface DiffTextLine {
  kind: "add" | "del" | "context" | "hunk" | "meta";
  text: string;
  /** Line numbers, where a hunk header gave them. */
  old?: number | undefined;
  new?: number | undefined;
}
export interface DiffText {
  lines: DiffTextLine[];
  additions: number;
  deletions: number;
  /** The files it changes, from their `+++`/`---` headers, in order. */
  files: string[];
  /** Whether any hunk header numbered its lines. */
  numbered: boolean;
}

const gitHeader =
  /^(?:diff --git |index |new file mode |deleted file mode |similarity index |rename (?:from|to) |old mode |new mode |\\ )/;
const headerFile = (line: string) => {
  const path = line.slice(4).trim().split("\t")[0] ?? "";
  return path === "/dev/null" ? undefined : path.replace(/^[ab]\//, "");
};

/**
 * Every line of a unified diff exactly as written, classified, with hunk numbering where the
 * headers give it. Unlike `parseUnifiedDiff` it drops nothing: a diff an agent wrote may lack
 * hunk headers or have counts that don't add up, and a reader must still see all of it.
 */
export function readDiffText(text: string): DiffText {
  const raw = text.split("\n");
  const lines: DiffTextLine[] = [];
  let additions = 0;
  let deletions = 0;
  const files: string[] = [];
  let numbered = false;
  let oldLine: number | undefined;
  let newLine: number | undefined;
  // After `diff --git`, until its first hunk, `---`/`+++` name files.
  let inHeader = false;
  raw.forEach((line, index) => {
    const hunk = hunkHeader.exec(line);
    if (hunk) {
      numbered = true;
      inHeader = false;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      lines.push({ kind: "hunk", text: line });
      return;
    }
    if (gitHeader.test(line)) {
      if (line.startsWith("diff --git ")) inHeader = true;
      lines.push({ kind: "meta", text: line });
      return;
    }
    // Outside a git header, `---`/`+++` name files only as a pair; alone they're changes.
    const pairedOld = line.startsWith("--- ") && raw[index + 1]?.startsWith("+++ ");
    const pairedNew = line.startsWith("+++ ") && raw[index - 1]?.startsWith("--- ");
    const outsideHunk = oldLine === undefined || inHeader;
    // A pair a hunk header follows starts the next file, even after earlier hunks.
    const startsFile =
      (pairedOld && hunkHeader.test(raw[index + 2] ?? "")) ||
      (pairedNew && hunkHeader.test(raw[index + 1] ?? ""));
    const isFileHeader = outsideHunk
      ? inHeader
        ? /^(?:---|\+\+\+) /.test(line)
        : pairedOld || pairedNew
      : startsFile;
    if (isFileHeader) {
      // A new file is named by `+++`, a deleted one only by `---`.
      const named = headerFile(line);
      const other = headerFile(raw[line.startsWith("---") ? index + 1 : index - 1] ?? "    ");
      if (named && (line.startsWith("+++ ") || !other) && !files.includes(named)) files.push(named);
      lines.push({ kind: "meta", text: line });
      return;
    }
    if (line.startsWith("+")) {
      additions++;
      lines.push({ kind: "add", text: line, new: newLine });
      if (newLine !== undefined) newLine++;
    } else if (line.startsWith("-")) {
      deletions++;
      lines.push({ kind: "del", text: line, old: oldLine });
      if (oldLine !== undefined) oldLine++;
    } else {
      lines.push({ kind: "context", text: line, old: oldLine, new: newLine });
      if (oldLine !== undefined) oldLine++;
      if (newLine !== undefined) newLine++;
    }
  });
  return { lines, additions, deletions, files, numbered };
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
