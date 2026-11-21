import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  CodeEditor,
  type EditorHandle,
  type EditorStatus,
  type EditorStatusActions,
} from "@/features/editor";
import type { BufferEditorProps } from "./editor-host.ts";

/**
 * A group's shown editor: `CodeEditor` on the buffer's shared document (spec 56), so every view
 * of the file edits one text. Its own status line is off; it reports to the editor's one line.
 */
export function BufferEditor(props: BufferEditorProps) {
  const { buffer, onStatus } = props;
  const subscribe = useCallback((changed: () => void) => buffer.subscribe(changed), [buffer]);
  const view = useSyncExternalStore(subscribe, () => buffer.view());
  const handle = useRef<EditorHandle>(null);
  // What the gutter compares against: the last saved or read text, so unsaved lines stay marked
  // when this view remounts (a tab switch) and clear once saved.
  const base = useSyncExternalStore(subscribe, () => buffer.baseText()) ?? "";
  const dirty = useSyncExternalStore(subscribe, () => buffer.snapshot().dirty);
  // The setters reach whichever editor is mounted when a status-line menu is used.
  const actions = useMemo<EditorStatusActions>(
    () => ({
      setIndent: (indent) => handle.current?.statusActions().setIndent(indent),
      setLineEnding: (ending) => handle.current?.statusActions().setLineEnding(ending),
      setLanguage: (language) => handle.current?.statusActions().setLanguage(language),
      setWhitespace: (show) => handle.current?.statusActions().setWhitespace(show),
    }),
    [],
  );
  // The editor tells a status once per change; the editor's copy is cleared when this unmounts,
  // so a re-run of the effect below (StrictMode, a new `onStatus`) tells it again.
  const last = useRef<EditorStatus | undefined>(undefined);
  const report = useCallback(
    (status: EditorStatus) => {
      last.current = status;
      onStatus(status, actions);
    },
    [onStatus, actions],
  );
  const { onEdited, look } = props;
  const edited = useCallback(() => {
    buffer.edited();
    onEdited?.();
  }, [buffer, onEdited]);
  // Alt+Z flips wrap for this view; the setting is where it starts.
  const [wrapFlip, setWrapFlip] = useState<{ from: boolean; wrap: boolean }>();
  const wrapDefault = look?.wordWrap ?? false;
  const wrap = wrapFlip?.from === wrapDefault ? wrapFlip.wrap : wrapDefault;
  const { reveal, onRevealed } = props;
  // The view remounts for each reveal of a line, so even the line already shown comes into view
  // again; it stays mounted once the reveal is taken.
  const [mount, setMount] = useState(reveal?.line === undefined ? 0 : reveal.token);
  if (reveal?.line !== undefined && reveal.token !== mount) setMount(reveal.token);
  // Spec 12–13: the caret (or the match) at the place asked for, and the keyboard there when
  // the open was deliberate. The editor scrolls the line into view itself.
  useEffect(() => {
    const editor = handle.current;
    if (!reveal || !editor || !view) return;
    if (reveal.line !== undefined) {
      const at = { line: Math.max(0, reveal.line - 1), column: reveal.column ?? 0 };
      editor.setSelections([
        { anchor: at, head: { line: at.line, column: at.column + (reveal.length ?? 0) } },
      ]);
    }
    if (reveal.focus) editor.focus();
    onRevealed?.(reveal.token);
  }, [reveal, onRevealed, view]);
  useEffect(() => {
    if (last.current) onStatus(last.current, actions);
    return () => onStatus(undefined);
  }, [onStatus, actions]);
  if (!view) return null;
  return (
    <CodeEditor
      // A new reveal brings its line into view again, even one already shown.
      key={mount}
      ref={handle}
      document={view}
      text={base}
      path={props.path}
      label={`Source of ${props.path}`}
      statusLine={false}
      marks={dirty ? undefined : props.marks}
      onMarkClick={dirty ? undefined : props.onMarkClick}
      peek={dirty ? undefined : props.peek}
      layer={props.layer}
      line={reveal?.line}
      column={reveal?.column}
      onEdit={edited}
      onBlur={props.onBlurred}
      onStatus={report}
      wrap={wrap}
      onToggleWrap={() => setWrapFlip({ from: wrapDefault, wrap: !wrap })}
      {...(look
        ? {
            fontSize: look.fontSize,
            lineHeight: look.lineHeight,
            fontFamily: look.fontFamily,
            renderWhitespace: look.renderWhitespace,
            indentGuides: look.indentGuides,
            stickyScroll: look.stickyScroll,
            cursorBlinking: look.cursorBlinking,
          }
        : {})}
    />
  );
}
