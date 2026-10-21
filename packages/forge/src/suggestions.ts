/**
 * Suggested changes in review comments: GitHub's ```suggestion fenced block, whose lines replace
 * the commented line range of the PR head. Pure; the daemon and the web panel share it.
 */

const opening = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;

/**
 * The replacement lines of a comment's one suggestion block, or undefined when the body holds no
 * suggestion, more than one, or one that never closes.
 */
export function suggestionOf(body: string): string[] | undefined {
  const lines = body.replaceAll("\r\n", "\n").split("\n");
  let found: string[] | undefined;
  for (let index = 0; index < lines.length; index++) {
    const open = opening.exec(lines[index] ?? "");
    if (!open) continue;
    const fence = open[1] ?? "";
    const closing = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
    const end = lines.findIndex((line, at) => at > index && closing.test(line));
    if (end < 0) return undefined;
    if (open[2]?.toLowerCase() === "suggestion") {
      if (found) return undefined;
      found = lines.slice(index + 1, end);
    }
    index = end;
  }
  return found;
}

export type SuggestionEdit = {
  /** First replaced line, 1-based. */
  startLine: number;
  /** Last replaced line, inclusive. */
  endLine: number;
  lines: readonly string[];
};

/**
 * The file's text with every edit applied, keeping its line endings and final newline, or
 * undefined when an edit falls outside the file or two edits overlap.
 */
export function applySuggestions(
  text: string,
  edits: readonly SuggestionEdit[],
): string | undefined {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const final = text.endsWith(eol);
  const body = final ? text.slice(0, -eol.length) : text;
  const lines = text === "" ? [] : body.split(eol);
  const sorted = edits.toSorted((a, b) => a.startLine - b.startLine);
  for (let index = 0; index < sorted.length; index++) {
    const edit = sorted[index];
    const previous = sorted[index - 1];
    if (!edit || edit.startLine < 1 || edit.endLine < edit.startLine) return undefined;
    if (edit.endLine > lines.length) return undefined;
    if (previous && previous.endLine >= edit.startLine) return undefined;
  }
  for (const edit of sorted.toReversed())
    lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...edit.lines);
  if (!lines.length) return "";
  return lines.join(eol) + (final ? eol : "");
}
