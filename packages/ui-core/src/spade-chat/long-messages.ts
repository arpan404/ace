/*
 * A long message folds in place (ADR 0212 amendment 2): it stays one message, whatever its length,
 * headings or tables, and once finished its bubble shows its first twenty lines with Show more under
 * them. Lines are what the client draws, wrapped ones included, so the client measures; this rule
 * only says which finished messages could be that tall, so a short one is never measured.
 */

/** A folded bubble shows this many of its lines. */
export const spadeFoldLines = 20;

/**
 * The fewest characters a drawn line holds on the narrowest bubble (a phone's, at the largest
 * text size most people use): text shorter than twenty of these, on twenty lines or fewer, can't
 * wrap past twenty.
 */
const fewestLineChars = 24;

/**
 * Whether a finished message may draw taller than twenty lines, and so folds when it does: more than
 * twenty lines that aren't blank, or enough words to wrap past twenty.
 */
export function spadeMayFold(text: string): boolean {
  let lines = 0;
  for (const line of text.split("\n")) if (line.trim() !== "") lines += 1;
  return lines > spadeFoldLines || [...text].length > spadeFoldLines * fewestLineChars;
}
