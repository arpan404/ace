import { contentHash, LruCache } from "@ace/ui-core";
import type { Token } from "marked";
import { highlight, type CodeToken } from "./highlight.ts";

/*
 * Markdown as a list of top-level blocks. A streaming message's settled blocks never change
 * once they cross to the page, so each keeps its object and its rendered elements; only the
 * open blocks after them are new on each update. Built in the markdown worker; in place where
 * there is no worker.
 */

export interface MarkdownBlock {
  token: Token;
  /** Highlighted tokens of a settled fenced code block. */
  code?: CodeToken[];
}
export interface MarkdownDoc {
  /** The settled blocks, then the open ones. */
  blocks: readonly MarkdownBlock[];
  /** How many of `blocks` are settled; the rest are still being written. */
  settled: number;
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

/** A settled block: a fenced code block is highlighted once, here. */
export function settledBlock(token: Token): MarkdownBlock {
  if (token.type !== "code" || typeof token.text !== "string") return { token };
  return {
    token,
    code: highlightCached(token.text, typeof token.lang === "string" ? token.lang : undefined),
  };
}
