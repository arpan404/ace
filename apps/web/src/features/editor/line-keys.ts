import type { Applied, EditorDocument, Selection } from "@ace/editor";
import { commentTokens } from "./comment.ts";
import { firstNonBlank, ordered } from "./cursor.ts";

/*
 * The line and comment keys, VS Code's: what each key asks the document to do. A key maps to an
 * edit (the core's own command, one undo step) or to new selections; keys.ts applies either and
 * reveals the caret. macOS uses Cmd and Alt, elsewhere Ctrl takes Cmd's place.
 */

export interface KeyLike {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export type EditorCommand =
  | { kind: "edit"; run(doc: EditorDocument): Applied | undefined }
  | { kind: "select"; run(doc: EditorDocument): Selection[] };

const edit = (run: (doc: EditorDocument) => Applied | undefined): EditorCommand => ({
  kind: "edit",
  run,
});

/** The edit or selection a key makes, or undefined when it is not a line key. */
export function lineCommand(event: KeyLike, mac: boolean, path: string): EditorCommand | undefined {
  const mod = mac ? event.metaKey : event.ctrlKey;
  const other = mac ? event.ctrlKey : event.metaKey;
  if (other && !(mac && event.ctrlKey && event.code === "KeyJ")) return undefined;
  const { key, code, altKey: alt, shiftKey: shift } = event;
  const vertical = key === "ArrowUp" || key === "ArrowDown";
  const up = key === "ArrowUp";

  if (!mod && alt && shift && vertical)
    return edit((doc) => (up ? doc.copyLinesUp() : doc.duplicateLines()));
  if (!mod && alt && !shift && vertical)
    return edit((doc) => (up ? doc.moveLinesUp() : doc.moveLinesDown()));
  if (mod && shift && !alt && code === "KeyK") return edit((doc) => doc.deleteLines());
  if (mod && !alt && key === "Enter")
    return edit((doc) => (shift ? doc.insertLineAbove() : doc.insertLineBelow()));
  if (!mod && !alt && key === "Tab") return edit((doc) => (shift ? doc.outdentLines() : doc.tab()));
  if (mod && !alt && !shift && (code === "BracketRight" || code === "BracketLeft"))
    return edit((doc) => (code === "BracketRight" ? doc.indentLines() : doc.outdentLines()));
  // Ctrl+J joins lines on macOS; elsewhere Ctrl+J is the app's terminal key.
  if (mac && event.ctrlKey && !event.metaKey && !alt && !shift && code === "KeyJ")
    return edit((doc) => doc.joinLines());
  if (mod && !alt && !shift && code === "KeyL") return { kind: "select", run: selectLines };
  if (mod && !alt && !shift && (key === "/" || code === "Slash")) {
    const tokens = commentTokens(path);
    if (tokens?.line) {
      const token = tokens.line;
      return edit((doc) => doc.toggleLineComment(token));
    }
    const block = tokens?.block;
    if (block) return edit((doc) => blockCommentLines(doc, block));
    return undefined;
  }
  if (!mod && alt && shift && code === "KeyA") {
    const block = commentTokens(path)?.block;
    if (!block) return undefined;
    return edit((doc) => doc.toggleBlockComment(block[0], block[1]));
  }
  return undefined;
}

/** Cmd+L: every selection grows to whole lines, and again by the next line each time. */
export function selectLines(doc: EditorDocument): Selection[] {
  const last = doc.lenLines() - 1;
  return doc.selections().map((selection) => {
    const { start, end } = ordered(selection);
    const head =
      end.line < last
        ? { line: end.line + 1, column: 0 }
        : { line: last, column: doc.line(last).length };
    return { anchor: { line: start.line, column: 0 }, head };
  });
}

/** Cmd+/ in a language with only block comments: a caret's line content becomes the comment. */
function blockCommentLines(
  doc: EditorDocument,
  [open, close]: readonly [string, string],
): Applied | undefined {
  const selections = doc.selections().map((selection) => {
    const { start, end } = ordered(selection);
    if (start.line !== end.line || start.column !== end.column) return selection;
    const text = doc.line(start.line);
    if (!text.trim()) return selection;
    return {
      anchor: { line: start.line, column: firstNonBlank(text) },
      head: { line: start.line, column: text.trimEnd().length },
    };
  });
  doc.setSelections(selections);
  return doc.toggleBlockComment(open, close);
}
