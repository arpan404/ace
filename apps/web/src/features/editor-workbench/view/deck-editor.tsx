import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  CodeEditor,
  type EditorHandle,
  type EditorStatus,
  type EditorStatusActions,
} from "@/features/editor";
import type { DeckEditorProps } from "./deck-host.ts";
import { fileName } from "./paths.ts";

/**
 * A group's shown editor: `CodeEditor` on the buffer's shared document (spec 56), so every view
 * of the file edits one text. Its own status line is off; it reports to the Deck's one line.
 */
export function DeckEditor(props: DeckEditorProps) {
  const { buffer, onStatus } = props;
  const subscribe = useCallback((changed: () => void) => buffer.subscribe(changed), [buffer]);
  const view = useSyncExternalStore(subscribe, () => buffer.view());
  const handle = useRef<EditorHandle>(null);
  // What the gutter compares against: the text as this view first showed it.
  const opening = useMemo(() => view?.doc.text() ?? "", [view]);
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
  // The editor tells a status once per change; the Deck's copy is cleared when this unmounts,
  // so a re-run of the effect below (StrictMode, a new `onStatus`) tells it again.
  const last = useRef<EditorStatus | undefined>(undefined);
  const report = useCallback(
    (status: EditorStatus) => {
      last.current = status;
      onStatus(status, actions);
    },
    [onStatus, actions],
  );
  const edited = useCallback(() => buffer.edited(), [buffer]);
  useEffect(() => {
    if (last.current) onStatus(last.current, actions);
    return () => onStatus(undefined);
  }, [onStatus, actions]);
  if (!view) return null;
  return (
    <CodeEditor
      ref={handle}
      document={view}
      text={opening}
      path={props.path}
      label={fileName(props.path)}
      statusLine={false}
      onEdit={edited}
      onStatus={report}
    />
  );
}
