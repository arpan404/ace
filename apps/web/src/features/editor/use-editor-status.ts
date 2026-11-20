import type { Indent } from "@ace/editor";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  editorStatus,
  sameStatus,
  type EditorStatus,
  type EditorStatusActions,
} from "./editor-status.ts";
import type { EditorDocumentState } from "./use-editor.ts";

/*
 * One editor's status and its setters, built from the document and the view's own choices
 * (a picked language, whitespace marks). `onStatus` hears each change that would read
 * differently, so a workbench can keep one status line for whichever editor is focused.
 */

export function useEditorStatus(options: {
  state: EditorDocumentState;
  readOnly: boolean;
  /** The language in use, and whether it was picked over the file's own. */
  language: string | undefined;
  languageChosen: boolean;
  setChosenLanguage(language: string | null | undefined): void;
  whitespace: boolean;
  setWhitespace(show: boolean): void;
  onStatus?: ((status: EditorStatus) => void) | undefined;
}): { status: EditorStatus | undefined; actions: EditorStatusActions } {
  // Kept out of the compiler: the indent and line ending are read from the document, which
  // changes them in place, so a memoized read keyed on the document would go stale.
  "use no memo";
  const { state, readOnly, language, languageChosen, whitespace, onStatus } = options;
  const doc = state.doc;
  /** Bumped when the indent setting changes, which lives in the document, not in React. */
  const [indentRevision, setIndentRevision] = useState(0);
  const indent = doc?.indent();
  const lineEnding = doc?.lineEnding() ?? "\n";
  const tabs = indent?.tabs ?? false;
  const size = indent?.size ?? 2;

  const status = useMemo(
    () =>
      doc
        ? editorStatus({
            selections: state.selections,
            primary: state.primary,
            indent: { tabs, size },
            lineEnding,
            language,
            languageChosen,
            whitespace,
            readOnly,
          })
        : undefined,
    // oxlint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- the indent lives in the document; its revision and values are the inputs.
    [
      doc,
      state.selections,
      state.primary,
      tabs,
      size,
      lineEnding,
      language,
      languageChosen,
      whitespace,
      readOnly,
      indentRevision,
    ],
  );

  const actions: EditorStatusActions = {
    setIndent: (next: Indent) => {
      doc?.setIndent(next);
      setIndentRevision((value) => value + 1);
    },
    setLineEnding: (ending) => {
      if (readOnly || !doc || doc.lineEnding() === ending) return;
      state.edit((target) => target.setLineEnding(ending));
    },
    setLanguage: (next) => options.setChosenLanguage(next === "file" ? undefined : (next ?? null)),
    setWhitespace: options.setWhitespace,
  };

  const told = useRef<EditorStatus | undefined>(undefined);
  useEffect(() => {
    if (!status || !onStatus) return;
    if (told.current && sameStatus(told.current, status)) return;
    told.current = status;
    onStatus(status);
  }, [status, onStatus]);

  return { status, actions };
}
