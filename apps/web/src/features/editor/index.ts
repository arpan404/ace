/*
 * The Files tab's code editor. The public surface is the view (and its handle for placing
 * carets); everything else — geometry, cursors, the highlighter adapter — stays inside.
 */

export { CodeEditor, type CodeEditorProps, type EditorHandle } from "./editor.tsx";
export type { LineHighlighter, Token } from "./highlighter.ts";
