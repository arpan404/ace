import type { ComposerToken } from "@ace/ui-core";

/**
 * Whether the editor already shows `text` with `tokens` as its chips, so it is left alone and
 * the browser's own editing (caret, selection, IME) is never disturbed. Only an edit that changes
 * the text from outside (a recalled message, an undo) or the chips themselves rebuilds it. Pure.
 */
export function editorInSync(
  dom: { text: string; tokens: readonly string[] },
  text: string,
  tokens: readonly ComposerToken[],
): boolean {
  return (
    dom.text === text &&
    dom.tokens.length === tokens.length &&
    tokens.every((token, index) => dom.tokens[index] === text.slice(token.start, token.end))
  );
}
