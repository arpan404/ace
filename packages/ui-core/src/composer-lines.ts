/*
 * The composer's text read as Markdown lines: a heading (`# `, `## `, `### `), a list item
 * (`- `, `* `, `1. `, `1) `, indented for nesting) or plain words. Lists nest by indentation,
 * the way Markdown reads them; any other line ends them. Pure.
 */

interface LineBase {
  /** Index of the line in the text. */
  index: number;
  start: number;
  /** Where the line ends, before its newline. */
  end: number;
}

export interface PlainLine extends LineBase {
  kind: "plain";
}

export interface HeadingLine extends LineBase {
  kind: "heading";
  level: 1 | 2 | 3;
  /** Where the words start, after `#… `. */
  content: number;
}

export interface ItemLine extends LineBase {
  kind: "item";
  /** Spaces before the marker. */
  indent: number;
  /** `-`, `*`, `1.` or `1)`. */
  marker: string;
  /** The number of an ordered item; undefined for a bullet. */
  number: number | undefined;
  /** 1 for a top-level item, 2 for one nested under it, and so on. */
  depth: number;
  /** Where the words start, after the marker and its space. */
  content: number;
}

export type ComposerLine = PlainLine | HeadingLine | ItemLine;

const heading = /^(#{1,3}) /;
const item = /^( *)([-*]|(\d{1,9})[.)]) /;

/** Every line of `text`, in order. */
export function composerLines(text: string): ComposerLine[] {
  const lines: ComposerLine[] = [];
  // Open lists, outermost first, by the indent of their items.
  const open: number[] = [];
  let start = 0;
  let index = 0;
  for (const words of text.split("\n")) {
    const end = start + words.length;
    const base = { index, start, end };
    const titled = heading.exec(words);
    const listed = titled ? null : item.exec(words);
    if (titled) {
      const marks = titled[1] ?? "#";
      lines.push({
        ...base,
        kind: "heading",
        level: marks.length === 1 ? 1 : marks.length === 2 ? 2 : 3,
        content: start + marks.length + 1,
      });
      open.length = 0;
    } else if (listed) {
      const indent = listed[1]?.length ?? 0;
      const marker = listed[2] ?? "-";
      while (open.length && (open.at(-1) ?? 0) > indent) open.pop();
      if ((open.at(-1) ?? -1) < indent) open.push(indent);
      lines.push({
        ...base,
        kind: "item",
        indent,
        marker,
        number: listed[3] === undefined ? undefined : Number(listed[3]),
        depth: open.length,
        content: start + listed[0].length,
      });
    } else {
      lines.push({ ...base, kind: "plain" });
      open.length = 0;
    }
    start = end + 1;
    index++;
  }
  return lines;
}

/** The line `offset` is on. */
export function lineAt(lines: readonly ComposerLine[], offset: number): ComposerLine {
  const found = lines.find((line) => offset >= line.start && offset <= line.end);
  return found ?? lines.at(-1) ?? { kind: "plain", index: 0, start: 0, end: 0 };
}

/** The item before `line` in its own list at its own level, if there is one. */
export function previousSibling(
  lines: readonly ComposerLine[],
  line: ItemLine,
): ItemLine | undefined {
  for (let at = line.index - 1; at >= 0; at--) {
    const other = lines[at];
    if (other?.kind !== "item" || other.indent < line.indent) return undefined;
    if (other.indent === line.indent) return other;
  }
  return undefined;
}

/** The item `line` is nested under, if it is nested. */
export function parentItem(lines: readonly ComposerLine[], line: ItemLine): ItemLine | undefined {
  for (let at = line.index - 1; at >= 0; at--) {
    const other = lines[at];
    if (other?.kind !== "item") return undefined;
    if (other.indent < line.indent) return other;
  }
  return undefined;
}
