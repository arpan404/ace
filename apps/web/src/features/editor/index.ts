/*
 * The Files tab's code editor. The public surface is the view (and its handle for placing
 * carets); everything else — geometry, cursors, the highlighter adapter — stays inside.
 */

export { CodeEditor } from "./editor.tsx";
export type {
  CodeEditorProps,
  DocumentView,
  EditBatch,
  EditorHandle,
  SharedDocument,
} from "./types.ts";
export { ensureEditorReady } from "./wasm.ts";
export type { LineHighlighter, Token } from "./highlighter.ts";
export { EditorStatusLine } from "./status-line.tsx";
export {
  indentText,
  languageName,
  lineEndingText,
  positionText,
  type EditorStatus,
  type EditorStatusActions,
} from "./editor-status.ts";
export { useEditorAnnotations, type EditorAnnotationsOptions } from "./annotate.tsx";
export type { EditorLayer, EditorLayerView } from "./layer.ts";
