import { contentHash, LruCache } from "@ace/ui-core";
import { highlight, type CodeToken } from "./highlight.ts";

/*
 * Whole source files as highlighted lines, for a file viewer with a line-number gutter. Built in
 * the markdown worker (it already highlights code blocks); in place where there is no worker.
 */

export interface CodeLines {
  hash: string;
  /** One entry per line of the source (a final newline leaves an empty last line). */
  lines: CodeToken[][];
}

/** The key a file's lines are cached under: its language and its text. */
export function codeHash(code: string, lang: string | undefined): string {
  return contentHash(`${lang ?? ""}\u0000${code}`);
}

/** Split highlighted tokens at newlines, so each line can render beside its number. */
export function splitLines(tokens: readonly CodeToken[]): CodeToken[][] {
  const lines: CodeToken[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines.at(-1)?.push({ kind: token.kind, text: part });
    });
  }
  return lines;
}

const built = new LruCache<string, CodeLines>({
  maxEntries: 16,
  maxWeight: 8 * 1024 * 1024,
  weigh: (doc) => doc.lines.reduce((sum, line) => sum + 16 + line.length * 24, 64),
});

export function codeLines(code: string, lang: string | undefined, hash = codeHash(code, lang)) {
  const cached = built.get(hash);
  if (cached) return cached;
  const doc: CodeLines = { hash, lines: splitLines(highlight(code, lang)) };
  built.set(hash, doc);
  return doc;
}
