import {
  EditorDocument,
  lineMarks,
  type Applied,
  type LineEdit,
  type Selection,
  type TextReplacement,
} from "@ace/editor";
import { fileLanguage, type LineMark } from "@ace/ui-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { MarkitLineHighlighter } from "./highlighter.ts";
import { ensureEditorReady } from "./wasm.ts";

/*
 * One open editor document and everything around it that is state: the Wasm document, the
 * selections a render draws, the syntax colours, the gutter diff and the idle commit that keeps
 * a typing run one undo step. The rendering layer only reads what this returns. Nothing here
 * copies the whole text on a keystroke: drafts and saves read it through a getter when they need it.
 */

export interface EditorDocumentState {
  /** Undefined until the Wasm has loaded and the document exists. */
  doc: EditorDocument | undefined;
  highlighter: MarkitLineHighlighter | undefined;
  /** True when the editor's Wasm could not load: the view offers a retry. */
  failed: boolean;
  /** Bumped on every applied edit, so a render walks the new text. */
  version: number;
  selections: readonly Selection[];
  primary: number;
  /** Gutter marks against the original text, once the first edit has settled. */
  marks: ReadonlyMap<number, LineMark> | undefined;
  /** Applies one command and redraws; false when read-only or nothing changes. */
  edit(run: (doc: EditorDocument) => Applied | undefined): boolean;
  /** Replaces the whole text as one edit, keeping the selection and scroll where they were. */
  replaceText(text: string): void;
  /** Replaces the selections and ends the current typing run. */
  select(next: readonly Selection[]): void;
  /** Tries the Wasm load again after a failure. */
  retry(): void;
}

/** One applied edit's changed lines, with the document's line count and version after it. */
export interface EditBatch {
  spans: readonly LineEdit[];
  /** The ranges the transaction replaced, for carrying a stored position through it. */
  replacements: readonly TextReplacement[];
  lines: number;
  /** The document's version once the spans were applied. */
  version: number;
}

export function useEditorDocument(options: {
  text: string;
  path: string;
  /** Text the gutter compares against; undefined leaves the external marks alone. */
  original?: string | undefined;
  /** Called after each applied edit, with no text: ask `doc.text()` only when needed. */
  onEdit?: (() => void) | undefined;
  /**
   * Called just before an edit is applied, while the document still holds the text the layout
   * measured: the one moment a view can read its own rows without racing the new text.
   */
  onBeforeEdit?: (() => void) | undefined;
  /**
   * Called with one batch of spans for every applied edit, synchronously, before React renders
   * the document that edit produced: a layout that reads text must hear about the edit while
   * its own rows still describe the text before it.
   */
  onApplied?: ((batch: EditBatch) => void) | undefined;
  /** The last text, read once as the document goes away (a draft keeps what was typed). */
  onTextDispose?: ((text: string) => void) | undefined;
  /** Read-only editors drop every edit, including the browser's beforeinput paths. */
  editable?: boolean;
  /** Idle time after which a typing run becomes one undo step. */
  commitAfter?: number;
  /** How long typing settles before the whole file is highlighted again. */
  highlightDelay?: number;
}): EditorDocumentState {
  const { path, original } = options;
  const editable = options.editable ?? true;
  const [initial] = useState(options.text);
  const [doc, setDoc] = useState<EditorDocument>();
  const [highlighter, setHighlighter] = useState<MarkitLineHighlighter>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [version, setVersion] = useState(0);
  const [selections, setSelections] = useState<readonly Selection[]>([]);
  const [primary, setPrimary] = useState(0);
  const [marks, setMarks] = useState<ReadonlyMap<number, LineMark>>();
  const onEdit = useRef(options.onEdit);
  const onTextDispose = useRef(options.onTextDispose);
  const onBeforeEdit = useRef(options.onBeforeEdit);
  const onApplied = useRef(options.onApplied);
  const commitTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const commitAfter = options.commitAfter ?? 1_000;

  useEffect(() => {
    onEdit.current = options.onEdit;
    onTextDispose.current = options.onTextDispose;
    onBeforeEdit.current = options.onBeforeEdit;
    onApplied.current = options.onApplied;
  }, [options.onEdit, options.onTextDispose, options.onBeforeEdit, options.onApplied]);

  useEffect(() => {
    let live = true;
    let created: EditorDocument | undefined;
    let colours: MarkitLineHighlighter | undefined;
    ensureEditorReady().then(
      () => {
        if (!live) return;
        created = new EditorDocument(initial);
        const language = fileLanguage(path);
        const delay = options.highlightDelay;
        colours =
          delay === undefined
            ? new MarkitLineHighlighter(language)
            : new MarkitLineHighlighter(language, { delay });
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
      if (created) {
        // Before the document is freed: a tab that closes mid-typing still keeps its draft.
        onTextDispose.current?.(created.text());
        created.dispose();
      }
      colours?.dispose();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a highlight delay is fixed for the document's life.
  }, [initial, path, options.highlightDelay, attempt]);

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

  const after = useCallback(
    (batch: EditBatch, colours = true) => {
      if (!doc) return;
      if (colours)
        for (const span of batch.spans) {
          const inserted = doc.lines(span.firstLine, span.firstLine + span.insertedLines);
          highlighter?.edit(span.firstLine, span.removedLines, inserted);
        }
      onEdit.current?.();
      // Before React redraws: a layout that measures the new text must already know the edit.
      onApplied.current?.(batch);
      setSelections(doc.selections());
      setPrimary(doc.primarySelection());
      setVersion((value) => value + 1);
      scheduleCommit();
    },
    [doc, highlighter, scheduleCommit],
  );

  const edit = useCallback(
    (run: (target: EditorDocument) => Applied | undefined): boolean => {
      if (!doc || !editable) return false;
      onBeforeEdit.current?.();
      const applied = run(doc);
      if (!applied) return false;
      after({
        spans: applied.spans,
        replacements: applied.replacements,
        lines: doc.lenLines(),
        version: applied.version,
      });
      return true;
    },
    [doc, editable, after],
  );

  const replaceText = useCallback(
    (next: string) => {
      if (!doc || next === doc.text()) return;
      onBeforeEdit.current?.();
      const before = doc.selections();
      const last = Math.max(0, doc.lenLines() - 1);
      const applied = doc.apply([
        {
          range: {
            start: { line: 0, column: 0 },
            end: { line: last, column: doc.line(last).length },
          },
          text: next,
        },
      ]);
      // A read of the file from disk must not move the reader's place.
      doc.setSelections(before);
      // One whole-text replacement, never also an edit span for the same change.
      highlighter?.setText(next);
      // A reload is not an edit at the reader's position: its one range covers the file, and
      // mapping through it would put the view at the end. The remembered line stays where it is.
      after(
        { spans: applied.spans, replacements: [], lines: doc.lenLines(), version: applied.version },
        false,
      );
      commit();
    },
    [doc, highlighter, after, commit],
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
    let cancelled = false;
    const timer = setTimeout(() => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- the idle callback closes over the debounce's state.
      const run = () => {
        if (cancelled) return;
        const current = doc.text();
        if (current === original) {
          setMarks(undefined);
          return;
        }
        const next = new Map<number, LineMark>();
        for (const mark of lineMarks(original, current)) next.set(mark.line, mark.kind);
        setMarks(next.size ? next : undefined);
      };
      // A gutter diff must never sit between a keystroke and its frame.
      if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 500 });
      else run();
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
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
    replaceText,
    select,
    retry: () => {
      setFailed(false);
      setAttempt((value) => value + 1);
    },
  };
}
