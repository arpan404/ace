/*
 * A unified diff (one file's part of `git diff`, or a provider's patch) read exactly: every line
 * with its own terminator ("\r\n" kept as written, none where the diff says "\ No newline at end
 * of file"), so the text it replaced comes back byte for byte. Pure and linear in the diff.
 */

type Tag = " " | "-" | "+";

interface PatchLine {
  tag: Tag;
  /** The line with its terminator, exactly. */
  text: string;
}

interface PatchHunk {
  /** 1-based first line of the new side; for an empty new side, the line it follows. */
  newStart: number;
  newCount: number;
  oldCount: number;
  lines: PatchLine[];
}

const header = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A hunk has exactly the lines its header counts on each side: a diff cut short has fewer. */
function whole(hunk: PatchHunk): boolean {
  let old = 0;
  let next = 0;
  for (const line of hunk.lines) {
    if (line.tag !== "+") old++;
    if (line.tag !== "-") next++;
  }
  return old === hunk.oldCount && next === hunk.newCount;
}

/** The diff's hunks, or undefined when any of them is cut short (a capped reply). */
function hunksOf(diff: string): PatchHunk[] | undefined {
  const hunks: PatchHunk[] = [];
  let hunk: PatchHunk | undefined;
  const lines = diff.split("\n");
  // The diff's own last newline ends its last line, not an empty one.
  if (lines.at(-1) === "") lines.pop();
  for (const raw of lines) {
    const opened = header.exec(raw);
    if (opened) {
      hunk = {
        oldCount: opened[1] === undefined ? 1 : Number(opened[1]),
        newStart: Number(opened[2]),
        newCount: opened[3] === undefined ? 1 : Number(opened[3]),
        lines: [],
      };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const tag = raw[0];
    if (tag === "\\") {
      // "\ No newline at end of file": the line before it has no terminator.
      const last = hunk.lines.at(-1);
      if (last) last.text = last.text.slice(0, -1);
      continue;
    }
    // An empty line inside a hunk is a context line whose space was trimmed.
    if (raw === "") hunk.lines.push({ tag: " ", text: "\n" });
    else if (tag === " " || tag === "-" || tag === "+")
      hunk.lines.push({ tag, text: `${raw.slice(1)}\n` });
    else hunk = undefined;
  }
  return hunks.every(whole) ? hunks : undefined;
}

/** A text's lines, each with its own terminator. */
function withEndings(text: string): string[] {
  const lines: string[] = [];
  let from = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", from)) {
    lines.push(text.slice(from, at + 1));
    from = at + 1;
  }
  if (from < text.length) lines.push(text.slice(from));
  return lines;
}

/**
 * The committed text of a file from its text on disk and its part of `git diff`, exact to the
 * byte; undefined when the diff doesn't fit the text (it was read for another version) or a hunk
 * of it was cut short.
 */
export function committedFromPatch(disk: string, diff: string): string | undefined {
  const hunks = hunksOf(diff);
  if (!hunks) return undefined;
  const lines = withEndings(disk);
  const out: string[] = [];
  let at = 0;
  for (const hunk of hunks) {
    const from = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    if (from < at || from > lines.length) return undefined;
    for (; at < from; at++) out.push(lines[at] ?? "");
    for (const line of hunk.lines) {
      if (line.tag !== "-" && lines[at++] !== line.text) return undefined;
      if (line.tag !== "+") out.push(line.text);
    }
  }
  for (; at < lines.length; at++) out.push(lines[at] ?? "");
  return out.join("");
}
