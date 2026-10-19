import type {
  TokenizerExtension,
  TokenizerExtensionFunction,
  TokenizerStartFunction,
} from "marked";
import type { Token } from "marked";

/*
 * Agent math in prose: inline `\(...\)` and `$...$`, display `\[...\]` and
 * `$$...$$`. Marked would otherwise eat the backslashes as escapes (`\(` shows
 * as `(`), so this inline extension runs before its escape rule and keeps the
 * TeX. Code spans and fenced blocks win first (they swallow their whole span),
 * so math is never parsed inside code.
 *
 * `$` keeps currency alone: an opening `$` followed by whitespace never opens,
 * and a closing `$` preceded by whitespace or followed by a digit never closes,
 * so `$5 and $10` stays text. An opener with no closer stays text too, which is
 * what a streamed message shows until its formula arrives.
 */

/** One math span the lexer found; `Formula` renders it once KaTeX has loaded. */
export interface MathToken {
  type: "math";
  raw: string;
  /** The TeX between the delimiters. Empty while an opener waits for its closer. */
  tex: string;
  display: boolean;
  /** An opener with no closer yet: show `raw` as text, never KaTeX. */
  pending?: boolean;
  /**
   * Rendered HTML, attached by the markdown worker when the formula's block
   * settled there. `Formula` inserts it directly: no KaTeX work on arrival.
   */
  html?: string;
}

/** Whether a (worker-decoded) token is math this extension produced. */
export function isMathToken(token: unknown): token is MathToken {
  if (typeof token !== "object" || token === null) return false;
  const candidate = token as Record<string, unknown>;
  if (candidate.type !== "math" || typeof candidate.raw !== "string") return false;
  if (typeof candidate.tex !== "string" || typeof candidate.display !== "boolean") return false;
  if (candidate.pending !== undefined && typeof candidate.pending !== "boolean") return false;
  return candidate.html === undefined || typeof candidate.html === "string";
}

function parenMath(source: string, display: boolean): MathToken | undefined {
  const closer = display ? "\\]" : "\\)";
  const end = source.indexOf(closer, 2);
  if (end < 0)
    // No closer yet (streaming) or ever: keep the opener visible instead of
    // letting markdown's escape eat its backslash.
    return { type: "math", raw: source.slice(0, 2), tex: "", display, pending: true };
  const tex = source.slice(2, end);
  if (!/\S/.test(tex)) return undefined;
  return { type: "math", raw: source.slice(0, end + 2), tex, display };
}

function displayDollars(source: string): MathToken | undefined {
  const end = source.indexOf("$$", 2);
  if (end < 0) return undefined;
  const tex = source.slice(2, end);
  if (!/\S/.test(tex)) return undefined;
  return { type: "math", raw: source.slice(0, end + 2), tex, display: true };
}

function inlineDollar(source: string): MathToken | undefined {
  const first = source[1];
  if (first === undefined || first === "$" || /\s/.test(first)) return undefined;
  let at = 1;
  while (at < source.length) {
    const char = source[at];
    if (char === "\\") {
      at += 2;
      continue;
    }
    if (char === "$") {
      const tex = source.slice(1, at);
      const last = tex[tex.length - 1];
      if (last === undefined || /\s/.test(last)) return undefined;
      const after = source[at + 1];
      if (after !== undefined && /\d/.test(after)) return undefined;
      return { type: "math", raw: source.slice(0, at + 1), tex, display: false };
    }
    at += 1;
  }
  return undefined;
}

export const mathTokenizer: TokenizerExtensionFunction = (source) => {
  if (source.startsWith("\\(")) return parenMath(source, false);
  if (source.startsWith("\\[")) return parenMath(source, true);
  if (source.startsWith("$$")) return displayDollars(source);
  if (source.startsWith("$")) return inlineDollar(source);
  return undefined;
};

const delimiterPattern = /\\[([]|\$/;

export const mathStart: TokenizerStartFunction = (source) => {
  const at = source.search(delimiterPattern);
  return at < 0 ? undefined : at;
};

/** Whether `text` holds a math opener: the streaming parser's warm-up signal. */
export function hasMathDelimiter(text: string): boolean {
  return delimiterPattern.test(text);
}

/** The extension for `Marked.use` and for `new Lexer` options alike. */
export const mathExtension: TokenizerExtension = {
  name: "math",
  level: "inline",
  start: mathStart,
  tokenizer: mathTokenizer,
};

/**
 * Every unrendered math span in a token tree: paragraphs, headings and quotes
 * hold `tokens`, tables hold cells with `tokens`, lists hold items with
 * `tokens`. Defensive: anything else is skipped, never thrown on.
 */
export function collectUnrenderedMath(tokens: readonly Token[]): MathToken[] {
  const found: MathToken[] = [];
  const visit = (token: unknown): void => {
    if (isMathToken(token)) {
      if (!token.pending && token.html === undefined) found.push(token);
    }
    if (typeof token !== "object" || token === null) return;
    const children = (token as { tokens?: unknown }).tokens;
    if (Array.isArray(children)) for (const child of children) visit(child);
    const header = (token as { header?: unknown }).header;
    if (Array.isArray(header)) for (const cell of header) visit(cell);
    const rows = (token as { rows?: unknown }).rows;
    if (Array.isArray(rows)) for (const row of rows) visit(row);
    const items = (token as { items?: unknown }).items;
    if (Array.isArray(items)) for (const item of items) visit(item);
  };
  for (const token of tokens) visit(token);
  return found;
}
