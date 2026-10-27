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

/** A long paragraph cut into pieces at sentence ends, mirroring iOS `pieces`. */
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
      // The space between two sentences belongs to neither piece.
      start = next + 1;
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

/** Inline spans for one run of prose. Malformed markup stays literal. */
export type InlineSpan =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "emphasis"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; url: string };

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
          if (/^(https?:\/\/|ace:\/\/)/.test(url)) {
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
