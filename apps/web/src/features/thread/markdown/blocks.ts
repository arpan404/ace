import { contentHash, LruCache } from "@ace/ui-core";
import { Lexer, type Token } from "marked";
import { highlight, type CodeToken } from "./highlight.ts";

/*
 * Markdown as a list of top-level blocks, each keyed by the hash of its source. While a message
 * streams only its last block changes, so earlier blocks keep their key and their rendered
 * elements. Runs in the markdown worker; in place where there is no worker.
 */

export interface MarkdownBlock {
  /** Hash of the block's source, plus its rank among identical blocks of the document. */
  key: string;
  token: Token;
  /** Highlighted tokens of a fenced code block. */
  code?: CodeToken[];
}
export interface MarkdownDoc {
  hash: string;
  blocks: MarkdownBlock[];
}

const highlighted = new LruCache<string, CodeToken[]>({
  maxEntries: 512,
  maxWeight: 4 * 1024 * 1024,
  weigh: (tokens) => tokens.reduce((sum, token) => sum + token.text.length + 16, 0),
});

/** Highlight `code`, reusing the result for the same language and text. */
export function highlightCached(code: string, lang: string | undefined): CodeToken[] {
  const key = contentHash(`${lang ?? ""}\u0000${code}`);
  const cached = highlighted.get(key);
  if (cached) return cached;
  const tokens = highlight(code, lang);
  highlighted.set(key, tokens);
  return tokens;
}

export function markdownDoc(text: string, hash = contentHash(text)): MarkdownDoc {
  const seen = new Map<string, number>();
  const blocks: MarkdownBlock[] = [];
  for (const token of Lexer.lex(text, { gfm: true, breaks: false })) {
    if (token.type === "space" || token.type === "def") continue;
    const source = contentHash(token.raw);
    const rank = seen.get(source) ?? 0;
    seen.set(source, rank + 1);
    const block: MarkdownBlock = { key: `${source}#${rank}`, token };
    if (token.type === "code" && typeof token.text === "string")
      block.code = highlightCached(
        token.text,
        typeof token.lang === "string" ? token.lang : undefined,
      );
    blocks.push(block);
  }
  return { hash, blocks };
}
