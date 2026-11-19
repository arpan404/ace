/*
 * The formatting a chat bubble shows (ADR 0127): paragraphs, headings, lists, quotes, tables and
 * code blocks, and inside a line bold, italic, struck-through text, inline code and links. Its
 * marks never show as written: a rule line goes, a heading's hashes go, an image reads as its
 * link. Pure, so web and iOS share one reading of a message.
 */

export type SpadeInline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "strike"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

export type SpadeBlock =
  | { kind: "paragraph"; inlines: SpadeInline[] }
  | { kind: "heading"; inlines: SpadeInline[] }
  | { kind: "quote"; inlines: SpadeInline[] }
  | { kind: "list"; ordered: boolean; items: SpadeInline[][] }
  | { kind: "table"; head: SpadeInline[][]; rows: SpadeInline[][][] }
  /** `language`: what the fence named ("ts"), undefined when it named nothing. */
  | { kind: "code"; text: string; language: string | undefined };

const fence = /^\s*```\s*([\w+#.-]*)/;
const closing = /^\s*```\s*$/;
// A task's box reads as the item: "- [x] Pack" is "Pack".
const bullet = /^\s*[-*+\u2022]\s+(?:\[[ xX]\]\s+)?(.*)$/;
const numbered = /^\s*\d+[.)]\s+(.*)$/;
const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const quote = /^\s{0,3}>\s?(.*)$/;
const rule = /^\s{0,3}(?:[-*_]\s*){3,}$/;
const tableRow = /^\s*\|.*\|\s*$/;
const tableRule = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

export function spadeMarkup(text: string): SpadeBlock[] {
  const blocks: SpadeBlock[] = [];
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length)
      blocks.push({ kind: "paragraph", inlines: spadeInlines(paragraph.join("\n")) });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const opened = fence.exec(line);
    if (opened) {
      flush();
      const code: string[] = [];
      // A block still being written runs to the end.
      for (index++; index < lines.length && !closing.test(lines[index] ?? ""); index++)
        code.push(lines[index] ?? "");
      blocks.push({ kind: "code", text: code.join("\n"), language: opened[1] || undefined });
      continue;
    }
    if (tableRow.test(line) && tableRule.test(lines[index + 1] ?? "")) {
      flush();
      const head = cells(line);
      const rows: SpadeInline[][][] = [];
      for (index += 2; index < lines.length && tableRow.test(lines[index] ?? ""); index++)
        rows.push(cells(lines[index] ?? ""));
      index--;
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    const titled = heading.exec(line);
    if (titled) {
      flush();
      blocks.push({ kind: "heading", inlines: spadeInlines(titled[1] ?? "") });
      continue;
    }
    if (rule.test(line)) {
      flush();
      continue;
    }
    const quoted = quote.exec(line);
    if (quoted) {
      flush();
      const said = [quoted[1] ?? ""];
      while (index + 1 < lines.length && quote.test(lines[index + 1] ?? ""))
        said.push(quote.exec(lines[++index] ?? "")?.[1] ?? "");
      blocks.push({ kind: "quote", inlines: spadeInlines(said.join("\n").trim()) });
      continue;
    }
    const item = bullet.exec(line) ?? numbered.exec(line);
    if (item) {
      flush();
      const ordered = !bullet.test(line);
      const last = blocks.at(-1);
      const inlines = spadeInlines(item[1] ?? "");
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(inlines);
      else blocks.push({ kind: "list", ordered, items: [inlines] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** A table row's cells, each read as a line. */
function cells(line: string): SpadeInline[][] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => spadeInlines(cell.trim()));
}

/**
 * `` `code` ``, `**bold**` or `__bold__`, `~~struck~~`, `*italic*` or `_italic_` (not inside a
 * word: snake_case stays), `[words](https://…)` and `![picture](https://…)`, and bare https
 * links; the rest is text.
 */
const inline = new RegExp(
  [
    /`([^`\n]+)`/.source,
    /\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/.source,
    /~~([^~\n]+?)~~/.source,
    /(?<![\w*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?![\s_])([^_\n]+?)(?<!\s)_(?![\w_])/
      .source,
    /!?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/.source,
    /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/.source,
  ].join("|"),
  "g",
);

export function spadeInlines(text: string): SpadeInline[] {
  const out: SpadeInline[] = [];
  let at = 0;
  for (const match of text.matchAll(inline)) {
    const start = match.index;
    if (start > at) out.push({ kind: "text", text: text.slice(at, start) });
    const [whole, code, bold, boldUnder, strike, italic, italicUnder, label, href, bare] = match;
    if (code !== undefined) out.push({ kind: "code", text: code });
    else if ((bold ?? boldUnder) !== undefined)
      out.push({ kind: "bold", text: bold ?? boldUnder ?? "" });
    else if (strike !== undefined) out.push({ kind: "strike", text: strike });
    else if ((italic ?? italicUnder) !== undefined)
      out.push({ kind: "italic", text: italic ?? italicUnder ?? "" });
    else if (label !== undefined && href !== undefined)
      out.push({ kind: "link", text: label, href });
    else if (bare !== undefined) out.push({ kind: "link", text: bare, href: bare });
    at = start + whole.length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

const inlineText = (inlines: readonly SpadeInline[]) => inlines.map((each) => each.text).join("");

/**
 * A message's words without their marks: what Copy puts on the clipboard and Read aloud says.
 * Code stays as written; a table's cells are separated by tabs, so it pastes as a table.
 */
export function spadePlainText(text: string): string {
  return spadeMarkup(text)
    .map((block) => {
      switch (block.kind) {
        case "code":
          return block.text;
        case "list":
          return block.items
            .map((item, at) => `${block.ordered ? `${at + 1}.` : "-"} ${inlineText(item)}`)
            .join("\n");
        case "table":
          return [block.head, ...block.rows]
            .map((row) => row.map(inlineText).join("\t"))
            .join("\n");
        default:
          return inlineText(block.inlines);
      }
    })
    .join("\n\n");
}
