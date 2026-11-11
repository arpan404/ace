import { decorationSignature, type ComposerToken, type DecorationNode } from "@ace/ui-core";

/**
 * Whether the editor already shows `text` drawn as `drawing`, with `tokens` as its chips, so it
 * is left alone and the browser's own editing (caret, selection, IME) is never disturbed. Only
 * an edit that changes the text from outside (a recalled message, an undo), the chips, or how
 * the text is drawn (a line that just became a heading) draws it again. `shown` is the editor's
 * signature (`editorSignature`). Pure.
 */
export function editorInSync(
  shown: string,
  drawing: readonly DecorationNode[],
  text: string,
  tokens: readonly ComposerToken[],
): boolean {
  return shown === decorationSignature(drawing, text, tokens);
}
