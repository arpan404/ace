import { EditorDocument, lineMarks, type Applied, type Selection } from "@ace/editor";
import { fileLanguage, type LineMark } from "@ace/ui-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { WholeFileLineHighlighter } from "./highlighter.ts";
import { ensureEditorReady } from "./wasm.ts";

/*
 * One open editor document and everything around it that is state: the Wasm document, the
 * selections a render draws, the syntax colours, the gutter diff and the idle commit that keeps
 * a typing run one undo step. The rendering layer only reads what this returns.
 */

export interface EditorDocumentState {
  /** Undefined until the Wasm has loaded and the document exists. */
  doc: EditorDocument | undefined;
  highlighter: WholeFileLineHighlighter | undefined;
  /** True when the editor's Wasm could not load: the caller shows the text plainly instead. */
  failed: boolean;
  /** Bumped on every applied edit, so a render walks the new text. */
  version: number;
  selections: readonly Selection[];
  primary: number;
  /** Gutter marks against the original text, once the first edit has settled. */
  marks: ReadonlyMap<number, LineMark> | undefined;
  /** Applies one command and redraws; false when the document has nothing to change. */
  edit(run: (doc: EditorDocument) => Applied | undefined): boolean;
  /** Replaces the selections and ends the current typing run. */
  select(next: readonly Selection[]): void;
}

export function useEditorDocument(options: {
  text: string;
  path: string;
  /** Text the gutter compares against; undefined leaves the external marks alone. */
  original?: string | undefined;
  /** Called with the whole text after each edit, for the caller's draft. */
  onTextChange?: ((text: string) => void) | undefined;
  /** Idle time after which a typing run becomes one undo step. */
  commitAfter?: number;
  /** How long typing settles before the whole file is highlighted again. */
  highlightDelay?: number;
}): EditorDocumentState {
  const { path, original } = options;
  const [initial] = useState(options.text);
  const [doc, setDoc] = useState<EditorDocument>();
  const [highlighter, setHighlighter] = useState<WholeFileLineHighlighter>();
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [selections, setSelections] = useState<readonly Selection[]>([]);
  const [primary, setPrimary] = useState(0);
  const [marks, setMarks] = useState<ReadonlyMap<number, LineMark>>();
  const onChange = useRef(options.onTextChange);
  const commitTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const commitAfter = options.commitAfter ?? 1_000;

  useEffect(() => {
    onChange.current = options.onTextChange;
  }, [options.onTextChange]);

  useEffect(() => {
    let live = true;
    let created: EditorDocument | undefined;
    let colours: WholeFileLineHighlighter | undefined;
    ensureEditorReady().then(
      () => {
        if (!live) return;
        created = new EditorDocument(initial);
        colours = new WholeFileLineHighlighter(fileLanguage(path), options.highlightDelay);
        setDoc(created);
        setHighlighter(colours);
        setSelections(created.selections());
        setPrimary(created.primarySelection());
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
      colours?.dispose();
      created?.dispose();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a highlight delay is fixed for the document's life.
  }, [initial, path, options.highlightDelay]);

  const commit = useCallback(() => {
    if (commitTimer.current !== undefined) clearTimeout(commitTimer.current);
    commitTimer.current = undefined;
    doc?.commit();
  }, [doc]);

  const scheduleCommit = useCallback(() => {
    if (commitTimer.current !== undefined) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      commitTimer.current = undefined;
      doc?.commit();
    }, commitAfter);
  }, [doc, commitAfter]);

  useEffect(
    () => () => {
      if (commitTimer.current !== undefined) clearTimeout(commitTimer.current);
    },
    [],
  );

  const edit = useCallback(
    (run: (target: EditorDocument) => Applied | undefined): boolean => {
      if (!doc) return false;
      const applied = run(doc);
      if (!applied) return false;
      for (const span of applied.spans) {
        const inserted = doc.lines(span.firstLine, span.firstLine + span.insertedLines);
        highlighter?.edit(span.firstLine, span.removedLines, inserted);
      }
      const text = doc.text();
      highlighter?.setText(text);
      onChange.current?.(text);
      setSelections(doc.selections());
      setPrimary(doc.primarySelection());
      setVersion((value) => value + 1);
      scheduleCommit();
      return true;
    },
    [doc, highlighter, scheduleCommit],
  );

  const select = useCallback(
    (next: readonly Selection[]) => {
      if (!doc) return;
      doc.setSelections(next);
      commit();
      setSelections(doc.selections());
      setPrimary(doc.primarySelection());
    },
    [doc, commit],
  );

  useEffect(() => {
    if (!doc || !original) return;
    const timer = setTimeout(() => {
      const current = doc.text();
      if (current === original) {
        setMarks(undefined);
        return;
      }
      const next = new Map<number, LineMark>();
      for (const mark of lineMarks(original, current)) next.set(mark.line, mark.kind);
      setMarks(next.size ? next : undefined);
    }, 180);
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- an edit changes the marks without changing the original text.
  }, [doc, version, original]);

  return {
    doc,
    highlighter,
    failed,
    version,
    selections,
    primary,
    marks,
    edit,
    select,
  };
}
