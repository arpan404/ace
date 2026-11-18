import type { Applied, EditorDocument } from "@ace/editor";
import { ordered, stepForward } from "./cursor.ts";

/* Clipboard and deletion over every selection, kept out of the view so it stays about drawing. */

/** What Copy puts on the clipboard: each selection's text, joined with a newline per cursor. */
export function copyText(doc: EditorDocument): string {
  return doc
    .selections()
    .map((selection) => {
      const { start, end } = ordered(selection);
      if (start.line === end.line) return doc.line(start.line).slice(start.column, end.column);
      const parts = [doc.line(start.line).slice(start.column)];
      for (let line = start.line + 1; line < end.line; line++) parts.push(doc.line(line));
      parts.push(doc.line(end.line).slice(0, end.column));
      return parts.join("\n");
    })
    .join("\n");
}

/** Cuts or deletes the selected text; carets with nothing selected are left alone. */
export function deleteSelections(doc: EditorDocument): Applied | undefined {
  const changes = doc.selections().flatMap((selection) => {
    const { start, end } = ordered(selection);
    if (start.line === end.line && start.column === end.column) return [];
    return [{ range: { start, end }, text: "" }];
  });
  return changes.length ? doc.apply(changes) : undefined;
}

/** Delete: the selection, or one character (or line break) after each caret. */
export function deleteForward(doc: EditorDocument): Applied | undefined {
  const lastLine = doc.lenLines() - 1;
  const changes = doc.selections().flatMap((selection) => {
    const { start, end } = ordered(selection);
    if (start.line !== end.line || start.column !== end.column)
      return [{ range: { start, end }, text: "" }];
    const text = doc.line(start.line);
    if (start.column < text.length)
      return [
        {
          range: { start, end: { line: start.line, column: stepForward(text, start.column) } },
          text: "",
        },
      ];
    if (start.line < lastLine)
      return [{ range: { start, end: { line: start.line + 1, column: 0 } }, text: "" }];
    return [];
  });
  return changes.length ? doc.apply(changes) : undefined;
}
