import { spadePlainText } from "./markup.ts";

/*
 * Long words in a chat (ADR 0212 §5): a `<doc>` the bot wrote, or a message too long for a
 * bubble, shows as a document card (its title, two lines of preview, Open) and never as a wall of
 * text. Nothing is cut: the card holds every word, and Open shows them.
 */

export interface SpadeDocCard {
  title: string;
  /** The first words as plain text, for two lines under the title. */
  preview: string;
  /** Every word, as written. */
  text: string;
}

/** A message past this many lines (blank ones aside) shows as a card. */
export const spadeMostBubbleLines = 12;
/** Or past this many characters, however few lines. */
const mostBubbleChars = 1600;
const mostSummaryChars = 400;
const mostPreviewChars = 240;

const headingLine = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const tableRule = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const notProse = /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||```|~~~|>)/;
const fenceLine = /^\s{0,3}(```|~~~)/;
const tableRow = /^\s*\|.*\|\s*$/;

/** A document's card. */
export function spadeDocCard(title: string | undefined, text: string): SpadeDocCard {
  return { title: title || "Document", preview: cut(previewOf(text), mostPreviewChars), text };
}

/**
 * The words a card's two lines show: headings, a table's head and rule left out, a row's cells
 * joined by a dot, every line run together.
 */
function previewOf(text: string): string {
  const lines = text.split("\n");
  const kept = lines
    .filter(
      (line, at) =>
        !headingLine.test(line) && !tableRule.test(line) && !tableRule.test(lines[at + 1] ?? ""),
    )
    .map((line) =>
      tableRow.test(line)
        ? line
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((cell) => cell.trim())
            .join(" · ")
        : line,
    );
  return spadePlainText(kept.join("\n"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * A message too long for a bubble, as its first paragraph and a card holding all of it: past
 * about 12 lines, or holding a heading or a table. Undefined when it fits in a bubble.
 */
export function spadeLongWords(text: string): { summary: string; doc: SpadeDocCard } | undefined {
  const lines = proseLines(text);
  const lineCount = text.split("\n").filter((line) => line.trim() !== "").length;
  const heading = lines.find((line) => headingLine.test(line));
  const table = lines.some((line) => tableRule.test(line) && line.includes("-"));
  if (
    lineCount <= spadeMostBubbleLines &&
    !heading &&
    !table &&
    [...text].length <= mostBubbleChars
  )
    return undefined;
  const title = heading ? spadePlainText(heading.replace(headingLine, "$1")).trim() : "";
  const first = text
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .find((chunk) => chunk && !notProse.test(chunk));
  return {
    summary: first ? cut(first, mostSummaryChars) : "",
    doc: spadeDocCard(title || "Full reply", text),
  };
}

/** The lines outside code blocks, where a heading or a table can be. */
function proseLines(text: string): string[] {
  const out: string[] = [];
  let code = false;
  for (const line of text.split("\n")) {
    if (fenceLine.test(line)) code = !code;
    else if (!code) out.push(line);
  }
  return out;
}

/** At most `most` characters, ending at a sentence or a word when it must be cut. */
function cut(text: string, most: number): string {
  const chars = [...text];
  if (chars.length <= most) return text;
  const head = chars.slice(0, most).join("");
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  if (sentence > most / 2) return head.slice(0, sentence + 1);
  const word = head.lastIndexOf(" ");
  return `${(word > most / 2 ? head.slice(0, word) : head).trimEnd()}…`;
}
