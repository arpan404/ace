import type { ChangeHunk } from "./change-hunks.ts";

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
  lines: PatchLine[];
}

const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

function hunksOf(diff: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let hunk: PatchHunk | undefined;
  const lines = diff.split("\n");
  // The diff's own last newline ends its last line, not an empty one.
  if (lines.at(-1) === "") lines.pop();
  for (const raw of lines) {
    const opened = header.exec(raw);
    if (opened) {
      hunk = {
        newStart: Number(opened[1]),
        newCount: opened[2] === undefined ? 1 : Number(opened[2]),
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
  return hunks;
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

const bare = (line: string) => line.replace(/\r?\n$/, "");

/**
 * The committed text of a file from its text on disk and its part of `git diff`, exact to the
 * byte; undefined when the diff doesn't fit the text (it was read for another version).
 */
export function committedFromPatch(disk: string, diff: string): string | undefined {
  const lines = withEndings(disk);
  const out: string[] = [];
  let at = 0;
  for (const hunk of hunksOf(diff)) {
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

/**
 * A diff's changes as gutter hunks over its new side, each carrying the exact text it replaced
 * (`removedText`) and the unchanged lines around it, so a revert puts back exactly what was there.
 */
export function exactPatchHunks(diff: string): ChangeHunk[] {
  const hunks: ChangeHunk[] = [];
  for (const hunk of hunksOf(diff)) {
    let line = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
    let above: string | undefined;
    let run: { start: number; added: string[]; removed: string[]; text: string } | undefined;
    const close = (below: string | undefined) => {
      if (!run) return;
      const { start, added, removed, text } = run;
      hunks.push({
        start,
        marks: added.length ? added.map((_, index) => start + index) : [Math.max(1, start)],
        added,
        removed,
        removedText: text,
        above,
        below,
      });
      run = undefined;
    };
    for (const each of hunk.lines) {
      if (each.tag === " ") {
        close(bare(each.text));
        above = bare(each.text);
        line++;
        continue;
      }
      run ??= { start: line, added: [], removed: [], text: "" };
      if (each.tag === "-") {
        run.removed.push(bare(each.text));
        run.text += each.text;
      } else {
        run.added.push(bare(each.text));
        line++;
      }
    }
    close(undefined);
  }
  return hunks;
}
