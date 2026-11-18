import type { EditorDocument } from "@ace/editor";
import { useCallback, useEffect, useState } from "react";

/*
 * The lines the editor draws: the visible window's text, read from the document when the window
 * moves or its text changes, with a lookup that falls back to the document for anything outside
 * the window (a caret, a selection end, a screen-reader mirror).
 */

export function useVisibleLines(options: {
  doc: EditorDocument | undefined;
  version: number;
  first: number;
  last: number;
}): { lines: string[]; lineAt(line: number): string } {
  const { doc, version, first, last } = options;
  const [lines, setLines] = useState<string[]>([""]);
  const key = `${version}:${first}:${last}`;
  useEffect(() => {
    // oxlint-disable-next-line react-compiler/set-state-in-effect -- the document is an external store; its lines change under React.
    setLines(doc ? doc.lines(first, last) : [""]);
    // oxlint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- the key already holds every input.
  }, [key, doc]);
  const lineAt = useCallback(
    (line: number): string => {
      if (line >= first && line < first + lines.length) return lines[line - first] ?? "";
      return doc?.line(line) ?? "";
    },
    [doc, first, lines],
  );
  return { lines, lineAt };
}
