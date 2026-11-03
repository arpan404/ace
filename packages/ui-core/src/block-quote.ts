/** `text` as a Markdown quote, each line behind "> ", then a blank line to write under. */
export function blockQuote(text: string): string {
  return `${text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")}\n\n`;
}

/**
 * What the person selected in an agent's message, quoted for their reply so the agent knows
 * which part they mean; undefined when the selection holds no words. Line ends are unified,
 * trailing spaces dropped and runs of blank lines kept to one, as the page's text shows them.
 */
export function selectionQuote(selected: string): string | undefined {
  const text = selected
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text ? blockQuote(text) : undefined;
}
