import type { Applied, EditorDocument } from "@ace/editor";
import { nextWord, ordered, stepForward } from "./cursor.ts";

/* Clipboard and deletion over every selection, kept out of the view so it stays about drawing. */

/** What Copy puts on the clipboard: each selection's text, joined by the document's ending. */
export function copyText(doc: EditorDocument): string {
  const ending = doc.lineEnding();
  return doc
    .selections()
    .map((selection) => {
      const { start, end } = ordered(selection);
      if (start.line === end.line) return doc.line(start.line).slice(start.column, end.column);
      const parts = [doc.line(start.line).slice(start.column)];
      for (let line = start.line + 1; line < end.line; line++) parts.push(doc.line(line));
      parts.push(doc.line(end.line).slice(0, end.column));
      return parts.join(ending);
    })
    .join(ending);
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

/** Delete word forward (Alt/Cmd+Delete): the selection, or the next word after each caret. */
export function deleteWordForward(doc: EditorDocument): Applied | undefined {
  const lastLine = doc.lenLines() - 1;
  const changes = doc.selections().flatMap((selection) => {
    const { start, end } = ordered(selection);
    if (start.line !== end.line || start.column !== end.column)
      return [{ range: { start, end }, text: "" }];
    const text = doc.line(start.line);
    if (start.column >= text.length) {
      if (start.line >= lastLine) return [];
      return [{ range: { start, end: { line: start.line + 1, column: 0 } }, text: "" }];
    }
    const to = nextWord(text, start.column);
    return [
      {
        range: {
          start,
          end: {
            line: start.line,
            column: to > start.column ? to : stepForward(text, start.column),
          },
        },
        text: "",
      },
    ];
  });
  return changes.length ? doc.apply(changes) : undefined;
}
