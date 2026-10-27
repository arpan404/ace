/**
 * Block structure of an agent's Markdown, ported from the iOS reference
 * (`apps/ios/Sources/Models/Markdown.swift`) for A05.02.
 *
 * Blocks: paragraphs, headings, lists, quotes, rules and fenced code, plus
 * comparison tables. A fence still streaming stays code until it closes.
 * Malformed input stays readable as prose; nothing here throws. Pure.
 */

export type MarkdownBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; language: string; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "rule" };

/** A long paragraph cut into pieces at sentence ends, mirroring iOS `pieces`.
 *
 * iOS drops the separating whitespace because its pieces stack in a `VStack`
 * (the line break replaces the space). Android flows pieces inline inside one
 * `Text` so prose wraps, so the separator stays at the start of the next
 * piece: `pieces.join("")` is the original paragraph. Appended text still only
 * changes the last piece.
 */
export function markdownPieces(paragraph: string, size = 2_000): string[] {
  if (paragraph === "") return [""];
  const pieces: string[] = [];
  let start = 0;
  let length = 0;
  let index = 0;
  while (index < paragraph.length) {
    const character = paragraph[index]!;
    const next = index + 1;
    length += 1;
    if (
      length >= size &&
      (character === "." || character === "!" || character === "?") &&
      next < paragraph.length &&
      /\s/.test(paragraph[next]!)
    ) {
      pieces.push(paragraph.slice(start, next));
      // The separator stays with the next piece so flowing prose keeps its
      // space; iOS drops it because its VStack line break replaces it.
      start = next;
      index = start;
      length = 0;
      continue;
    }
    index = next;
  }
  if (start < paragraph.length || pieces.length === 0) pieces.push(paragraph.slice(start));
  return pieces;
}

export function markdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;
  let fence: { marker: string; language: string; lines: string[] } | null = null;
  let table: { headers: string[]; rows: string[][] } | null = null;

  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    }
    if (quote.length > 0) {
      blocks.push({ kind: "quote", text: quote.join("\n") });
      quote = [];
    }
    if (list !== null) {
      blocks.push({ kind: "list", ordered: list.ordered, start: list.start, items: list.items });
      list = null;
    }
    if (table !== null) {
      blocks.push({ kind: "table", headers: table.headers, rows: table.rows });
      table = null;
    }
  };

  for (const raw of text.split("\n")) {
    const line = raw;
    const trimmed = line.trim();
    if (fence !== null) {
      const mark = fence.marker[0]!;
      let run = 0;
      while (trimmed[run] === mark) run += 1;
      if (run >= fence.marker.length && trimmed.slice(run).trim() === "") {
        blocks.push({ kind: "code", language: fence.language, text: fence.lines.join("\n") });
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    if (table !== null) {
      const cells = tableCells(line);
      if (cells !== null) {
        const padded = [...cells];
        while (padded.length < table.headers.length) padded.push("");
        table.rows.push(padded.slice(0, table.headers.length));
        continue;
      }
      flush();
    }
    const separators = tableCells(trimmed);
    if (
      separators !== null &&
      separators.length > 1 &&
      separators.every((cell) => {
        const marks = cell.replace(/:/g, "");
        return marks.length >= 3 && [...marks].every((c) => c === "-");
      })
    ) {
      const last = paragraph[paragraph.length - 1];
      if (last !== undefined) {
        const headers = tableCells(last);
        if (headers !== null && headers.length === separators.length) {
          paragraph = paragraph.slice(0, -1);
          flush();
          table = { headers, rows: [] };
          continue;
        }
      }
    }
    const marker = fenceMarker(trimmed);
    if (marker !== null) {
      flush();
      fence = { marker, language: trimmed.slice(marker.length).trim(), lines: [] };
      continue;
    }
    if (trimmed === "") {
      flush();
      continue;
    }
    const heading = parseHeading(trimmed);
    if (heading !== null) {
      flush();
      blocks.push(heading);
      continue;
    }
    if (isRule(trimmed)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    if (trimmed.startsWith(">")) {
      if (paragraph.length > 0 || list !== null) flush();
      quote.push(trimmed.slice(1).trim());
      continue;
    }
    const item = listItem(trimmed);
    if (item !== null) {
      if (paragraph.length > 0 || quote.length > 0) flush();
      if (list !== null && list.ordered === item.ordered) list.items.push(item.text);
      else {
        flush();
        list = { ordered: item.ordered, start: item.number, items: [item.text] };
      }
      continue;
    }
    if (list !== null && line.startsWith("  ") && list.items.length > 0) {
      // An indented line continues the item above it.
      const last = list.items[list.items.length - 1]!;
      list.items[list.items.length - 1] = `${last}\n${trimmed}`;
      continue;
    }
    if (quote.length > 0 || list !== null) flush();
    paragraph.push(line);
  }
  if (fence !== null)
    blocks.push({ kind: "code", language: fence.language, text: fence.lines.join("\n") });
  flush();
  return blocks;
}

/** iOS parity: a code block longer than this shows its first lines with Show all. */
export const CODE_VISIBLE_LINES = 20;
/** A block longer than visible lines + this margin collapses; barely-long blocks stay whole. */
export const CODE_COLLAPSE_MARGIN = 2;
/** Assistant text past this many characters opens elsewhere instead of the row. */
export const INLINE_MESSAGE_LIMIT = 200_000;
/** Preview characters shown when a message exceeds the inline limit. Bounds parsing. */
export const LONG_MESSAGE_PREVIEW_CHARS = 4_000;

export function isOverInlineLimit(text: string): boolean {
  return text.length > INLINE_MESSAGE_LIMIT;
}

/** Bounded preview for an over-limit message: plain slice, never markdown-parsed. */
export function longMessagePreview(text: string): string {
  if (text.length <= LONG_MESSAGE_PREVIEW_CHARS) return text;
  return backOffGraphemeEdge(text.slice(0, LONG_MESSAGE_PREVIEW_CHARS));
}

/**
 * A raw UTF-16 cut can strand a surrogate lead (renders as �) or detach a
 * combining mark, variation selector or zero-width joiner. Back off over a
 * trailing edge so the preview stays readable. ASCII previews are untouched,
 * so their exact length is preserved.
 */
function backOffGraphemeEdge(slice: string): string {
  let end = slice.length;
  while (end > 0 && isGraphemeEdge(slice.charCodeAt(end - 1)!)) end -= 1;
  return slice.slice(0, end);
}

function isGraphemeEdge(code: number): boolean {
  return (
    (code >= 0xd800 && code <= 0xdbff) || // lead surrogate whose pair was cut
    (code >= 0x0300 && code <= 0x036f) || // combining marks
    code === 0xfe0e ||
    code === 0xfe0f || // variation selectors
    code === 0x200d // zero-width joiner
  );
}

export function isCodeCollapsible(text: string): boolean {
  return lineCount(text) > CODE_VISIBLE_LINES + CODE_COLLAPSE_MARGIN;
}

export function visibleCodeText(text: string, expanded: boolean): string {
  if (expanded || !isCodeCollapsible(text)) return text;
  return text.split("\n").slice(0, CODE_VISIBLE_LINES).join("\n");
}

export function codeLineCount(text: string): number {
  return lineCount(text);
}

function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length;
}

/**
 * Streaming deltas re-render on every chunk. Past `STREAMING_FULL_PARSE_CHARS`
 * a full `markdownBlocks` parse per delta is O(n) each and O(n²) over the
 * stream, so the settled head is parsed once and only the tail re-parses.
 * The full text stays rendered: head blocks plus tail blocks concatenate to
 * exactly the full parse. Pure.
 */
export const STREAMING_FULL_PARSE_CHARS = 16_000;
/** Fresh tail re-parsed per delta while streaming a large message. */
export const STREAMING_TAIL_CHARS = 8_000;
/** The settled head only advances in chunks, so head re-parses stay amortized. */
export const STREAMING_HEAD_GROWTH_CHARS = 4_000;

/**
 * Split streaming text into a settled head and a fresh tail at a blank-line
 * boundary, where every parser state (paragraph, quote, list, table) is
 * already flushed. Returns null when a full parse is cheaper or safer: short
 * text, no blank-line boundary in range, or an unclosed fence in the head
 * (a fence spanning the cut would parse differently split than whole).
 */
export function streamingSplit(text: string): { head: string; tail: string } | null {
  if (text.length <= STREAMING_FULL_PARSE_CHARS) return null;
  const cut = text.lastIndexOf("\n\n", text.length - STREAMING_TAIL_CHARS);
  if (cut < 0) return null;
  const head = text.slice(0, cut + 2);
  if (isInOpenFence(head)) return null;
  return { head, tail: text.slice(cut + 2) };
}

/** True while `text` opens a fence it never closes (streaming code). */
export function isInOpenFence(text: string): boolean {
  let open: string | null = null;
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (open !== null) {
      const mark = open[0]!;
      let run = 0;
      while (trimmed[run] === mark) run += 1;
      if (run >= open.length && trimmed.slice(run).trim() === "") open = null;
    } else {
      const marker = fenceMarker(trimmed);
      if (marker !== null) open = marker;
    }
  }
  return open !== null;
}

/** The settled head cache: parsed once, reused across deltas. */
export interface StreamingAccumulator {
  head: string;
  blocks: MarkdownBlock[];
}

/**
 * One incremental step for a streaming message. Head blocks are referentially
 * stable while the head is unchanged, so settled rows keep their state; the
 * tail re-parses each call but stays bounded by `STREAMING_TAIL_CHARS` plus
 * one growth chunk. Non-append edits reset the head. `blocks` always equals
 * `markdownBlocks(text)` for text the split accepts, and falls back to the
 * full parse otherwise.
 */
export function accumulateStreamingBlocks(
  prev: StreamingAccumulator,
  text: string,
): { state: StreamingAccumulator; blocks: MarkdownBlock[] } {
  const split = streamingSplit(text);
  if (split === null) return { state: { head: "", blocks: [] }, blocks: markdownBlocks(text) };
  let head = prev.head;
  if (head !== "" && !text.startsWith(head)) head = "";
  if (head === "" || split.head.length >= head.length + STREAMING_HEAD_GROWTH_CHARS) {
    head = split.head;
    const blocks = markdownBlocks(head);
    const state = { head, blocks };
    return { state, blocks: [...blocks, ...markdownBlocks(text.slice(head.length))] };
  }
  return { state: prev, blocks: [...prev.blocks, ...markdownBlocks(text.slice(head.length))] };
}

/** Inline spans for one run of prose. Malformed markup stays literal.
 *
 * Subset, not iOS parity: handles `**`/`__`, `*`/`_`, `` ` `` and
 * `[text](https://…)`/`http://`. Autolinks, images, strikethrough,
 * nested/escaped emphasis and link titles stay literal. Only safe web URLs
 * become links; `ace://`, `javascript:` and anything with whitespace or
 * control characters stays literal so styled text is never a dead or unsafe
 * tap target.
 */
export type InlineSpan =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "emphasis"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; url: string };

/** Safe to open externally: http(s) only, bounded, no whitespace/controls. */
export function isSafeWebUrl(url: string): boolean {
  if (url.length === 0 || url.length > 2048) return false;
  if (!/^https?:\/\//.test(url)) return false;
  // Reject whitespace, controls and DEL; the parser already split on ")".
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(url)) return false;
  return true;
}

export function markdownInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let plain = "";
  const pushPlain = () => {
    if (plain !== "") {
      spans.push({ kind: "text", text: plain });
      plain = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith("**") || rest.startsWith("__")) {
      const mark = rest.slice(0, 2);
      const close = text.indexOf(mark, i + 2);
      if (close > i + 2) {
        pushPlain();
        spans.push({ kind: "strong", text: text.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
    }
    const ch = text[i]!;
    if (ch === "*" || ch === "_") {
      const close = text.indexOf(ch, i + 1);
      if (close > i + 1 && !/\s/.test(text[i + 1]!) && !/\s/.test(text[close - 1]!)) {
        pushPlain();
        spans.push({ kind: "emphasis", text: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      if (close > i + 1) {
        pushPlain();
        spans.push({ kind: "code", text: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    if (ch === "[") {
      const mid = text.indexOf("](", i + 1);
      if (mid > i + 1) {
        const end = text.indexOf(")", mid + 2);
        if (end > mid + 2) {
          const url = text.slice(mid + 2, end);
          if (isSafeWebUrl(url)) {
            pushPlain();
            spans.push({ kind: "link", text: text.slice(i + 1, mid), url });
            i = end + 1;
            continue;
          }
        }
      }
    }
    plain += ch;
    i += 1;
  }
  pushPlain();
  return spans.length > 0 ? spans : [{ kind: "text", text }];
}

/**
 * Content fingerprint over the full string: length plus a hash of every UTF-16
 * unit. A tail change past any window still changes the key, so memo'd rows
 * never reuse stale output while streaming. (The previous 64-char window kept
 * the same key when only the tail changed.)
 */
export function fingerprintText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)!) | 0;
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

/** Fingerprint of a block's full content: settled blocks keep stable keys. */
export function blockFingerprint(block: MarkdownBlock): string {
  switch (block.kind) {
    case "paragraph":
      return `p:${fingerprintText(block.text)}`;
    case "heading":
      return `h${block.level}:${fingerprintText(block.text)}`;
    case "code":
      return `code:${block.language}:${fingerprintText(block.text)}`;
    case "list":
      return `list:${block.ordered ? "o" : "u"}:${block.start}:${fingerprintText(block.items.join("\n"))}`;
    case "quote":
      return `q:${fingerprintText(block.text)}`;
    case "table":
      return `t:${fingerprintText([...block.headers, ...block.rows.flat()].join("\n"))}`;
    case "rule":
      return "rule";
  }
}

/** Fingerprint of a span's full content. */
export function spanFingerprint(span: InlineSpan): string {
  return span.kind === "link"
    ? `link:${fingerprintText(span.text)}:${fingerprintText(span.url)}`
    : `${span.kind}:${fingerprintText(span.text)}`;
}

/**
 * Content keys with occurrence counting: append-only deltas keep settled
 * entries (and their state) while duplicates stay unique.
 */
export function withStableKeys<T>(
  values: T[],
  fingerprint: (value: T) => string,
): { key: string; value: T }[] {
  const seen = new Map<string, number>();
  const keyed: { key: string; value: T }[] = [];
  for (const value of values) {
    const base = fingerprint(value);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    keyed.push({ key: `${base}#${occurrence}`, value });
  }
  return keyed;
}

function fenceMarker(line: string): string | null {
  for (const character of ["`", "~"]) {
    let run = 0;
    while (line[run] === character) run += 1;
    if (run >= 3) return line.slice(0, run);
  }
  return null;
}

/** Escaped pipes and pipes inside inline code belong to the cell, not its boundary. */
function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  let cells: string[] = [];
  let cell = "";
  let escaped = false;
  let code = false;
  let divided = false;
  for (const character of trimmed) {
    if (escaped) {
      cell += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "`") code = !code;
    if (character === "|" && !code) {
      cells.push(cell.trim());
      cell = "";
      divided = true;
    } else {
      cell += character;
    }
  }
  if (escaped) cell += "\\";
  if (!divided) return null;
  cells.push(cell.trim());
  if (cells[0] === "") cells = cells.slice(1);
  if (cells[cells.length - 1] === "") cells = cells.slice(0, -1);
  return cells.length === 0 ? null : cells;
}

function parseHeading(line: string): MarkdownBlock | null {
  let hashes = 0;
  while (line[hashes] === "#") hashes += 1;
  if (hashes < 1 || hashes > 6) return null;
  const rest = line.slice(hashes);
  if (!rest.startsWith(" ")) return null;
  return { kind: "heading", level: hashes, text: rest.trim() };
}

function isRule(line: string): boolean {
  const marks = line.replace(/ /g, "");
  if (marks.length < 3) return false;
  const first = marks[0]!;
  if (first !== "-" && first !== "_" && first !== "*") return false;
  return [...marks].every((c) => c === first);
}

function listItem(line: string): { ordered: boolean; number: number; text: string } | null {
  const first = line[0];
  if ((first === "-" || first === "*" || first === "+") && line[1] === " ") {
    return { ordered: false, number: 1, text: line.slice(2) };
  }
  let digits = 0;
  while (digits < line.length && /[0-9]/.test(line[digits]!)) digits += 1;
  if (digits === 0 || digits > 9) return null;
  const rest = line.slice(digits);
  const mark = rest[0];
  if ((mark !== "." && mark !== ")") || rest[1] !== " ") return null;
  return { ordered: true, number: Number(line.slice(0, digits)) || 1, text: rest.slice(2) };
}
