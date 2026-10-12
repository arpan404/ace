import { contentHash, LruCache } from "@ace/ui-core";

/*
 * A ```diff fence, line by line, for a unified-diff view. Unlike the Changes panel's parser this
 * keeps every line, headers and all, exactly as written: agents write diffs without hunk
 * headers or with counts that don't add up, and the reader must still see (and copy) all of it.
 */

export interface FenceDiffLine {
  kind: "add" | "del" | "context" | "hunk" | "meta";
  text: string;
  /** Line numbers, where a hunk header gave them. */
  old?: number | undefined;
  new?: number | undefined;
}
export interface FenceDiff {
  lines: FenceDiffLine[];
  additions: number;
  deletions: number;
  /** The file it changes, from its `+++`/`---` header. */
  file: string | undefined;
  /** Whether any hunk header numbered its lines. */
  numbered: boolean;
}

const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const header =
  /^(?:diff --git |index |new file mode |deleted file mode |similarity index |rename (?:from|to) |old mode |new mode |\\ )/;
const fileOf = (line: string) => {
  const path = line.slice(4).trim().split("\t")[0] ?? "";
  return path === "/dev/null" ? undefined : path.replace(/^[ab]\//, "");
};

export function parseFenceDiff(code: string): FenceDiff {
  const lines: FenceDiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let file: string | undefined;
  let numbered = false;
  let oldLine: number | undefined;
  let newLine: number | undefined;
  // Between a file header and its first hunk, `---`/`+++` name files rather than change lines.
  let inHeader = false;
  for (const text of code.split("\n")) {
    const at = hunk.exec(text);
    if (at) {
      numbered = true;
      inHeader = false;
      oldLine = Number(at[1]);
      newLine = Number(at[2]);
      lines.push({ kind: "hunk", text });
      continue;
    }
    if (header.test(text)) {
      if (text.startsWith("diff --git ")) inHeader = true;
      lines.push({ kind: "meta", text });
      continue;
    }
    const fileHeader =
      (text.startsWith("--- ") || text.startsWith("+++ ")) && (inHeader || oldLine === undefined);
    if (fileHeader) {
      if (text.startsWith("+++ ")) file = fileOf(text) ?? file;
      else file ??= fileOf(text);
      lines.push({ kind: "meta", text });
      continue;
    }
    if (text.startsWith("+")) {
      additions++;
      lines.push({ kind: "add", text, new: newLine });
      if (newLine !== undefined) newLine++;
    } else if (text.startsWith("-")) {
      deletions++;
      lines.push({ kind: "del", text, old: oldLine });
      if (oldLine !== undefined) oldLine++;
    } else {
      lines.push({ kind: "context", text, old: oldLine, new: newLine });
      if (oldLine !== undefined) oldLine++;
      if (newLine !== undefined) newLine++;
    }
  }
  return { lines, additions, deletions, file, numbered };
}

const parsed = new LruCache<string, FenceDiff>({
  maxEntries: 128,
  maxWeight: 4 * 1024 * 1024,
  weigh: (diff) => diff.lines.reduce((sum, line) => sum + line.text.length * 2 + 48, 64),
});

/** A settled fence's diff, parsed once per text however often it mounts. */
export function fenceDiffCached(code: string): FenceDiff {
  const key = contentHash(code);
  const cached = parsed.get(key);
  if (cached) return cached;
  const diff = parseFenceDiff(code);
  parsed.set(key, diff);
  return diff;
}
