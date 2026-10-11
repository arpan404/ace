import { contentHash, LruCache } from "@ace/ui-core";
import { highlight, type CodeToken } from "./highlight.ts";

/*
 * Whole source files as highlighted lines, for a file viewer with a line-number gutter. Built in
 * a worker; in place where there is no worker.
 */

/** Plain results reuse the caller's source rather than cloning a second per-line graph. */
export type CodeLines =
  | { hash: string; plain: true }
  | {
      hash: string;
      /** One entry per line of the source (a final newline leaves an empty last line). */
      lines: CodeToken[][];
    };

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

export function codeLinesWeight(doc: CodeLines): number {
  if ("plain" in doc) return 64;
  return doc.lines.reduce(
    (sum, line) =>
      sum +
      16 +
      line.reduce(
        (weight, token) =>
          weight +
          48 +
          2 * (token.text.length + (token.light?.length ?? 0) + (token.dark?.length ?? 0)),
        0,
      ),
    64,
  );
}

const resultLimit = 8 * 1024 * 1024;
const built = new LruCache<string, CodeLines>({
  maxEntries: 16,
  maxWeight: resultLimit,
  weigh: codeLinesWeight,
});

/** The line arrays and source alone may exceed the result budget before tokenization. */
function exceedsMinimumWeight(code: string): boolean {
  let weight = 80 + code.length * 2;
  if (weight > resultLimit) return true;
  for (let at = code.indexOf("\n"); at >= 0; at = code.indexOf("\n", at + 1)) {
    // Each newline replaces two source bytes with a sixteen-byte line entry.
    weight += 14;
    if (weight > resultLimit) return true;
  }
  return false;
}

export async function codeLines(
  code: string,
  lang: string | undefined,
  hash = codeHash(code, lang),
) {
  const cached = built.get(hash);
  if (cached) return cached;
  if (exceedsMinimumWeight(code)) {
    const plain: CodeLines = { hash, plain: true };
    built.set(hash, plain);
    return plain;
  }
  const colored = lang
    ? await import("./source-highlight.ts")
        .then((module) => module.sourceHighlight(code, lang))
        .catch(() => undefined)
    : undefined;
  let doc: CodeLines = { hash, lines: colored ?? splitLines(highlight(code, lang)) };
  // Cache eviction alone cannot bound the worker reply: dense grammars can turn modest
  // source into a much larger token graph. The caller already owns the exact plain source.
  if (codeLinesWeight(doc) > resultLimit) doc = { hash, plain: true };
  built.set(hash, doc);
  return doc;
}
