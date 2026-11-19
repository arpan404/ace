/*
 * Whether a message in a bubble is markdown, and the text to render when it is. Only structure a
 * writer means counts: a fenced block, a heading, a list of two or more items, a quote, a table,
 * a link, inline code or emphasis around words. Text that merely contains a `#`, a dash or an
 * asterisk stays plain, drawn as typed. Pure.
 */

const fence = /^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?\n {0,3}\1[ \t]*$/m;
const heading = /^ {0,3}#{1,6}[ \t]+\S/m;
const listItem = /^ {0,3}(?:[-*+]|\d{1,3}[.)])[ \t]+\S/;
const quote = /^ {0,3}>[ \t]?\S/m;
const tableRule = /^ {0,3}\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/m;
const link = /\[[^\]\n]+\]\((?:https?:|mailto:)[^)\s]+\)/;
const inlineCode = /(^|[^`])`[^`\n]+`(?!`)/;
const strong = /(^|[\s(])(\*\*|__)(?=\S)[^\n]*?\S\2(?=$|[\s).,:;!?])/m;
const emphasis = /(^|[\s(])([*_])(?=[^\s*_])[^\n*_]*?[^\s*_]\2(?=$|[\s).,:;!?])/m;

/** Two or more list items, each on its own line, next to each other. */
function hasList(text: string): boolean {
  let run = 0;
  for (const line of text.split("\n")) {
    if (listItem.test(line)) {
      run += 1;
      if (run >= 2) return true;
    } else if (line.trim()) run = 0;
  }
  return false;
}

/** Whether `text` reads as markdown a writer meant, so the bubble renders it. */
export function looksLikeMarkdown(text: string): boolean {
  return (
    fence.test(text) ||
    heading.test(text) ||
    hasList(text) ||
    quote.test(text) ||
    tableRule.test(text) ||
    link.test(text) ||
    inlineCode.test(text) ||
    strong.test(text) ||
    emphasis.test(text)
  );
}

/**
 * The markdown with every line break kept as typed: a line followed by another line in the same
 * paragraph ends in a hard break, so nothing reflows. Fenced code is left as it is.
 */
export function withHardBreaks(text: string): string {
  const lines = text.split("\n");
  let fenced: string | undefined;
  return lines
    .map((line, index) => {
      const marker = /^ {0,3}(```|~~~)/.exec(line)?.[1];
      if (marker && (!fenced || marker === fenced)) {
        fenced = fenced ? undefined : marker;
        return line;
      }
      const next = lines[index + 1];
      if (fenced || !line.trim() || next === undefined || !next.trim()) return line;
      return / {2,}$|\\$/.test(line) ? line : `${line}  `;
    })
    .join("\n");
}
