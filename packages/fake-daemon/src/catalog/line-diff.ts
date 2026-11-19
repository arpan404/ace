/*
 * Unified patches between two versions of a file, as GitHub draws them, for sample pull requests
 * whose patches are worked out from their files rather than typed out.
 */

type Op = { kind: " " | "-" | "+"; text: string; left: number; right: number };

/** Each line of `before` and `after`, kept, removed or added, by a longest common subsequence. */
function lineOps(before: readonly string[], after: readonly string[]): Op[] {
  const n = before.length;
  const m = after.length;
  const width = m + 1;
  const common = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      common[i * width + j] =
        before[i] === after[j]
          ? (common[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      ops.push({ kind: " ", text: before[i] ?? "", left: i++, right: j++ });
    } else if (
      i < n &&
      (j >= m || (common[(i + 1) * width + j] ?? 0) >= (common[i * width + j + 1] ?? 0))
    ) {
      ops.push({ kind: "-", text: before[i] ?? "", left: i++, right: j });
    } else {
      ops.push({ kind: "+", text: after[j] ?? "", left: i, right: j++ });
    }
  }
  return ops;
}

/** The patch from `before` to `after` with `context` unchanged lines around each change. */
export function unifiedPatch(
  before: readonly string[],
  after: readonly string[],
  context = 3,
): { patch: string; additions: number; deletions: number } {
  const ops = lineOps(before, after);
  const changed = ops.flatMap((op, at) => (op.kind === " " ? [] : [at]));
  const spans: { from: number; to: number }[] = [];
  for (const at of changed) {
    const from = Math.max(0, at - context);
    const to = Math.min(ops.length - 1, at + context);
    const last = spans.at(-1);
    if (last && from <= last.to + 1) last.to = to;
    else spans.push({ from, to });
  }
  const hunks = spans.map(({ from, to }) => {
    const rows = ops.slice(from, to + 1);
    const lefts = rows.filter((op) => op.kind !== "+").length;
    const rights = rows.filter((op) => op.kind !== "-").length;
    const first = rows[0];
    // With no lines on a side, the start names the line the hunk follows.
    const left = lefts ? (first?.left ?? 0) + 1 : (first?.left ?? 0);
    const right = rights ? (first?.right ?? 0) + 1 : (first?.right ?? 0);
    return [
      `@@ -${left},${lefts} +${right},${rights} @@`,
      ...rows.map((op) => `${op.kind}${op.text}`),
    ].join("\n");
  });
  return {
    patch: hunks.join("\n"),
    additions: ops.filter((op) => op.kind === "+").length,
    deletions: ops.filter((op) => op.kind === "-").length,
  };
}

/**
 * GitHub's diff hunk for a comment on new-side `line`: the patch's hunk holding it, from its
 * header through that line. Undefined when the patch doesn't draw the line.
 */
export function diffHunk(patch: string, line: number): string | undefined {
  let header: string | undefined;
  let rows: string[] = [];
  let right = 0;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      header = text;
      rows = [];
      right = Number(hunk[1]);
      continue;
    }
    if (!header) continue;
    rows.push(text);
    if (text.startsWith("-")) continue;
    if (right === line) return [header, ...rows].join("\n");
    right++;
  }
  return undefined;
}
