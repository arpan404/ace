import { Lexer, type Links, type Token } from "marked";

/*
 * Streamed markdown, parsed paragraph-wise. Text arrives in appends; the parser keeps a settled
 * head of finished top-level blocks, each lexed once, and an open tail lexed again on every
 * append from the last boundary. A block settles once the block after it has begun on a
 * complete line, so later text can no longer change it: a paragraph or a table a blank line
 * ended, a closed fence, a list or a quote another block followed. Once the text is final the
 * settled blocks are exactly what one lex of the whole text gives.
 *
 * Two things reach across blocks. A link reference definition (top-level or inside a quote or
 * a list) resolves references anywhere in the document: settled blocks resolve against the
 * definitions settled before them or with them, and when a definition settles after a block
 * that could hold a reference to it the settled head is lexed again, once. And inline HTML
 * state runs on from one block's inline text into the next (an `<a>` left open turns off
 * autolinks after it): each lex starts from the state the settled head ended in.
 */

const options = { gfm: true, breaks: false } as const;

export const isContent = (token: Token) => token.type !== "space" && token.type !== "def";

/**
 * Top-level block tokens of `source`, without inline tokens. Every definition is kept, even a
 * repeated label (a lex drops those), so the tokens' raw text tiles the source.
 */
function blockPass(source: string): Token[] {
  const lexer = new Lexer(options);
  // No prototype, so a label like `constructor` is not already "defined".
  lexer.tokens.links = new Proxy(Object.create(null), { set: () => true });
  return [...lexer.blockTokens(source, lexer.tokens)];
}

/** Definitions by label, with no inherited names (`constructor`, `__proto__`). */
const noLinks = (): Links => Object.create(null);

/** The inline state marked carries from one block's inline text to the next. */
interface InlineState {
  inLink: boolean;
  inRawBlock: boolean;
  linkEmitted: boolean;
}
const startState = (): InlineState => ({ inLink: false, inRawBlock: false, linkEmitted: false });

/**
 * `source` lexed whole as text that follows `links` (earlier definitions, which win) and ends
 * an inline run in `state`. Returns its blocks, the definitions it holds itself (nested ones
 * too) and the inline state it ends in.
 */
function lex(source: string, links: Links, state: InlineState) {
  const lexer = new Lexer(options);
  lexer.blockTokens(source, lexer.tokens);
  const own = Object.assign(noLinks(), lexer.tokens.links);
  Object.assign(lexer.tokens.links, links);
  Object.assign(lexer.state, state);
  for (const { src, tokens } of lexer.inlineQueue) lexer.inlineTokens(src, tokens);
  lexer.inlineQueue = [];
  const { inLink, inRawBlock, linkEmitted } = lexer.state;
  return {
    blocks: lexer.tokens.filter(isContent),
    own,
    state: { inLink, inRawBlock, linkEmitted },
  };
}

/** Whether the line before `at` (a line start) is blank. */
function blankBefore(source: string, at: number): boolean {
  if (at < 2 || source[at - 1] !== "\n") return false;
  const start = source.lastIndexOf("\n", at - 2) + 1;
  return /^[ \t]*$/.test(source.slice(start, at - 1));
}

/**
 * Where the settled blocks of `tokens` (block tokens of `source`, starting at `starts`) end:
 * the start of the first open block. The last block is open, and so is the one before it while
 * the last one's first line is incomplete (`#` may yet become `#tag`, which would continue the
 * paragraph above). A definition stays open until a blank line follows it: its title may
 * continue on the next lines.
 */
function settledEnd(tokens: readonly Token[], starts: readonly number[], source: string): number {
  const blocks: number[] = [];
  tokens.forEach((token, index) => {
    if (token.type !== "space") blocks.push(index);
  });
  let open = blocks.length - 1;
  const last = blocks[open];
  if (last === undefined) return 0;
  if (source.indexOf("\n", starts[last]) < 0) open--;
  for (; open > 0; open--) {
    const start = starts[blocks[open] ?? 0] ?? 0;
    if (tokens[blocks[open - 1] ?? 0]?.type !== "def" || blankBefore(source, start)) return start;
  }
  return 0;
}

export interface StreamBlocks {
  /** Index of the first block in `settled`: settled blocks before it are unchanged. */
  from: number;
  /** Blocks settled by this append, or every settled block again after a relex. */
  settled: Token[];
  /** The open blocks after the settled ones. */
  open: Token[];
}

/** One streamed document. Feed it appends; read back what settled and what is still open. */
export class BlockStream {
  /** Characters received, as sent (before line endings are normalized). */
  length = 0;
  private head = "";
  private tail = "";
  /** A trailing carriage return, held until the next append says whether `\n` follows. */
  private carry = "";
  private links = noLinks();
  /** Inline state at the end of the settled head. */
  private inline = startState();
  private count = 0;
  /** Whether a settled block holds a bracket, so a later definition could change it. */
  private bracketed = false;

  /** Characters held: the parser's share of a cache's budget. */
  get weight(): number {
    return this.head.length + this.tail.length;
  }

  push(append: string, final: boolean): StreamBlocks {
    this.length += append.length;
    let text = this.carry + append;
    this.carry = "";
    if (!final && text.endsWith("\r")) {
      this.carry = "\r";
      text = text.slice(0, -1);
    }
    this.tail += text.replace(/\r\n?/g, "\n");
    const tail = this.tail;
    let end = tail.length;
    if (!final) {
      const tokens = blockPass(tail);
      let at = 0;
      const starts = tokens.map((token) => {
        const start = at;
        at += token.raw.length;
        return start;
      });
      // Where raw text doesn't tile the source no boundary is trusted; the tail stays open.
      end = at === tail.length ? settledEnd(tokens, starts, tail) : 0;
    }
    if (!end)
      return { from: this.count, settled: [], open: lex(tail, this.links, this.inline).blocks };

    const source = tail.slice(0, end);
    const settled = lex(source, this.links, this.inline);
    let relex = false;
    // The first definition of a label wins, wherever it sits (a quote, a list).
    for (const [label, link] of Object.entries(settled.own)) {
      if (label in this.links) continue;
      this.links[label] = link;
      relex ||= this.bracketed;
    }
    this.head += source;
    this.tail = tail.slice(end);
    if (relex) {
      // A new definition may resolve a reference in a block settled earlier.
      const head = lex(this.head, this.links, startState());
      this.inline = head.state;
      this.count = head.blocks.length;
      return { from: 0, settled: head.blocks, open: this.openBlocks() };
    }
    this.inline = settled.state;
    this.bracketed ||= settled.blocks.some((token) => token.raw.includes("["));
    const from = this.count;
    this.count += settled.blocks.length;
    return { from, settled: settled.blocks, open: this.openBlocks() };
  }

  private openBlocks(): Token[] {
    return this.tail ? lex(this.tail, this.links, this.inline).blocks : [];
  }
}
