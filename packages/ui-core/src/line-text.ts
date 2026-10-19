/** The text on one line, cut to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The first non-blank line of the text, cut to `max` characters; undefined when it is blank. */
export function firstLine(text: string | undefined, max = 120): string | undefined {
  const line = text
    ?.split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  return line ? clip(line, max) : undefined;
}
