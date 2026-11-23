import { spadePlainText } from "./markup.ts";

/*
 * A `<doc>` the bot wrote in a chat (ADR 0212 §5) shows as a document card: its title, two lines
 * of preview, Open. Nothing is cut: the card holds every word, and Open shows them. A message is
 * never a card, however long: it folds in place instead (`long-messages.ts`, amendment 2).
 */

export interface SpadeDocCard {
  title: string;
  /** The first words as plain text, for two lines under the title. */
  preview: string;
  /** Every word, as written. */
  text: string;
}

const mostPreviewChars = 240;

const headingLine = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const tableRule = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
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
