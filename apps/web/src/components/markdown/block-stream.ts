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

function fenceStart(source: string) {
  const match = /^( {0,3})(`{3,}|~{3,})([^\n]*)\n/.exec(source);
  return match?.[2] && !(match[2][0] === "`" && match[3]?.includes("`"))
    ? {
        marker: match[2],
        length: match[0].length,
        lang: match[3]?.trim(),
        // Match the parser's indentation compensation, which applies to backtick fences.
        indent: match[2][0] === "`" ? (match[1]?.length ?? 0) : 0,
      }
    : undefined;
}

function closesFence(line: string, marker: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!match?.[1] && match[1][0] === marker[0] && match[1].length >= marker.length;
}

/** Whether the last line of a code token is a closing fence. */
function closedFence(source: string): boolean {
  const fence = fenceStart(source);
  if (!fence) return false;
  const end = source.endsWith("\n") ? source.length - 1 : source.length;
  const start = source.lastIndexOf("\n", end - 1) + 1;
  return start >= fence.length && closesFence(source.slice(start, end), fence.marker);
}

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
  private parseAt = 8192;
  private scanned = 0;
  private lineStart = 0;
  private previewType = "paragraph";
  private closedPreview: { token: Token; end: number } | undefined;
  private candidate = { at: 0, indent: 0, count: 0, padding: false, invalid: false };
  private candidateClosed = false;
  private dedented:
    | { start: number; indent: number; at: number; leading: number; text: string }
    | undefined;

  /** Only the newly appended body is examined; partial leading whitespace resumes next time. */
  private fenceText(fence: NonNullable<ReturnType<typeof fenceStart>>): string {
    if (!fence.indent) return this.tail.slice(fence.length);
    if (this.dedented?.start !== fence.length || this.dedented.indent !== fence.indent)
      this.dedented = {
        start: fence.length,
        indent: fence.indent,
        at: fence.length,
        leading: 0,
        text: "",
      };
    const body = this.dedented;
    const parts: string[] = [];
    let start = body.at;
    for (; body.at < this.tail.length; body.at++) {
      const char = this.tail[body.at];
      if (char === "\n") body.leading = 0;
      else if (body.leading < body.indent && char !== undefined && /\s/.test(char)) {
        if (start < body.at) parts.push(this.tail.slice(start, body.at));
        start = body.at + 1;
        body.leading++;
      } else body.leading = body.indent;
    }
    parts.push(this.tail.slice(start));
    body.text += parts.join("");
    // An unfinished fence consumes one final source newline outside its code text. Keep
    // that newline in the cache: a later append can make it an interior newline again.
    return this.tail.endsWith("\n") ? body.text.slice(0, -1) : body.text;
  }

  /** An EOF closing marker is valid now but may be invalidated by a later append on its line. */
  private closingCandidate(marker: string | undefined): boolean {
    if (this.candidate.at < this.lineStart)
      this.candidate = { at: this.lineStart, indent: 0, count: 0, padding: false, invalid: false };
    const candidate = this.candidate;
    if (!marker || !this.lineStart) return false;
    for (; candidate.at < this.tail.length; candidate.at++) {
      const char = this.tail[candidate.at];
      if (candidate.invalid) continue;
      if (char === marker[0] && !candidate.padding) candidate.count++;
      else if (candidate.count && (char === " " || char === "\t")) candidate.padding = true;
      else if (!candidate.count && char === " " && candidate.indent < 3) candidate.indent++;
      else candidate.invalid = true;
    }
    return !candidate.invalid && candidate.count >= marker.length;
  }

  /** Scan each newly completed line once. Ordinary fence body lines cannot force a reparse.
   * Long incomplete lines resume at the last character scanned, without copying their prefix.
   */
  private newBoundary(): boolean {
    const fence = fenceStart(this.tail);
    let boundary = false;
    for (
      let end = this.tail.indexOf("\n", this.scanned);
      end >= 0;
      end = this.tail.indexOf("\n", end + 1)
    ) {
      if (this.lineStart > 0) {
        const line = this.tail.slice(this.lineStart, end);
        boundary ||=
          this.closedPreview && this.lineStart >= this.closedPreview.end && /\S/.test(line)
            ? true
            : fence
              ? closesFence(line, fence.marker)
              : (this.previewType === "paragraph" || this.previewType === "table") &&
                (/^[ \t]*$/.test(line) ||
                  /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|[-+*] |\d{1,9}[.)] |`{3,}|~{3,}|<|(?:[-*_][ \t]*){3,}$|=+[ \t]*$)/.test(
                    line,
                  ));
      }
      this.lineStart = end + 1;
    }
    this.scanned = this.tail.length;
    const closed = this.closingCandidate(fence?.marker);
    boundary ||= closed !== this.candidateClosed;
    this.candidateClosed = closed;
    return boundary;
  }

  /** A giant unfinished block stays readable without reparsing its entire prefix per delta. */
  private preview(): Token[] {
    if (this.closedPreview) {
      if (this.candidateClosed) return [{ ...this.closedPreview.token, raw: this.tail }];
      const rest = this.tail.slice(this.closedPreview.end);
      return [
        this.closedPreview.token,
        ...(rest.length > 8192 ? this.paragraph(rest) : lex(rest, this.links, this.inline).blocks),
      ];
    }
    const fence = fenceStart(this.tail);
    if (fence)
      return [
        {
          type: "code",
          raw: this.tail,
          text: this.fenceText(fence),
          lang: fence.lang,
        },
      ];
    this.dedented = undefined;
    return this.paragraph(this.tail);
  }

  private paragraph(text: string): Token[] {
    return [
      {
        type: "paragraph",
        raw: text,
        text,
        tokens: [{ type: "text", raw: text, text }],
      },
    ];
  }

  /** Characters held: the parser's share of a cache's budget. */
  get weight(): number {
    return this.head.length + this.tail.length + (this.dedented?.text.length ?? 0);
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
    const boundary = this.newBoundary();
    if (
      !final &&
      tail.length > 8192 &&
      tail.length < this.parseAt &&
      !boundary &&
      (this.previewType === "paragraph" || this.previewType === "table" || fenceStart(tail))
    )
      return { from: this.count, settled: [], open: this.preview() };
    this.parseAt = Math.max(8192, tail.length * 2);
    let end = tail.length;
    if (!final) {
      const tokens = blockPass(tail);
      this.previewType = tokens.find(isContent)?.type ?? "paragraph";
      let at = 0;
      const starts = tokens.map((token) => {
        const start = at;
        at += token.raw.length;
        return start;
      });
      // Where raw text doesn't tile the source no boundary is trusted; the tail stays open.
      end = at === tail.length ? settledEnd(tokens, starts, tail) : 0;
      if (end)
        this.previewType =
          tokens.find((token, index) => (starts[index] ?? 0) >= end && isContent(token))?.type ??
          "paragraph";
    }
    if (!end) {
      // Geometric reparses discover boundaries; they do not alternate a giant unfinished
      // block between rich and plain rendering. Its rich token is published once it closes.
      if (tail.length > 8192 && (this.previewType === "paragraph" || this.previewType === "table"))
        return { from: this.count, settled: [], open: this.preview() };
      const open = lex(tail, this.links, this.inline).blocks;
      const first = open[0];
      this.closedPreview = undefined;
      if (
        first?.type === "code" &&
        closedFence(first.raw) &&
        (first.raw.endsWith("\n") || tail[first.raw.length] === "\n" || this.candidateClosed)
      )
        this.closedPreview = {
          token: first,
          end: first.raw.length + (first.raw.endsWith("\n") || this.candidateClosed ? 0 : 1),
        };
      return { from: this.count, settled: [], open };
    }

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
    this.closedPreview = undefined;
    this.dedented = undefined;
    this.candidate = { at: 0, indent: 0, count: 0, padding: false, invalid: false };
    this.candidateClosed = false;
    this.scanned = 0;
    this.lineStart = 0;
    this.parseAt = Math.max(8192, this.tail.length * 2);
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
    return this.tail
      ? this.tail.length > 8192 &&
        (this.previewType === "paragraph" || this.previewType === "table" || fenceStart(this.tail))
        ? this.preview()
        : lex(this.tail, this.links, this.inline).blocks
      : [];
  }
}
