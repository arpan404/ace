/*
 * The editor: a thread's editor workbench view (docs/editor/workbench.md, W3). Layout rules come
 * from W1's model (`@ace/ui-core/editor-workbench`); buffers from W2's registry
 * (`editor-workbench/buffers`), held per open path by `useEditorBuffers`.
 */

export { Editor, type EditorProps } from "./editor.tsx";
export { OpenEditors } from "./open-editors.tsx";
export type { EditorLayoutProps } from "./group-actions.ts";
export {
  editorBuffers,
  useEditorBuffers,
  useSnapshot,
  type Changer,
  type EditorBuffers,
} from "./editor-buffers.ts";
export { BufferEditor } from "./buffer-editor.tsx";
export { compactBelowPx } from "./editor.tsx";
export type {
  EditorCompareProps,
  BufferEditorProps,
  EditorViewerProps,
  EditorReveal,
  StatusNotice,
  StatusReport,
} from "./editor-host.ts";
