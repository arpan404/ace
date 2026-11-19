/*
 * The Files tab's code editor. The public surface is the view (and its handle for placing
 * carets); everything else — geometry, cursors, the highlighter adapter — stays inside.
 */

export { CodeEditor } from "./editor.tsx";
export type { CodeEditorProps, EditorHandle } from "./types.ts";
export type { LineHighlighter, Token } from "./highlighter.ts";
