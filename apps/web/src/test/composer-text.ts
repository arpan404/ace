import { act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { editorText, placeEditorCaret } from "@/features/thread/composer/editor-dom.ts";

/*
 * The rich-text composer as a person sees and types into it. It draws one element per line and
 * each file as a chip where it was added, so its `textContent` runs lines together and carries
 * file names in the words.
 */

function seen(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement)) return "";
  if (node.dataset.tokenText !== undefined) return `[${node.getAttribute("aria-label") ?? ""}]`;
  return [...node.childNodes].map(seen).join("");
}

/** The composer's lines as shown, joined by newlines, each file's chip as `[name]`. */
export function composerWords(field: Element): string {
  return [...field.children].map(seen).join("\n");
}

/**
 * Type at the end of the composer's words, where a click past them puts the caret in a browser:
 * after a trailing file chip. (user-event's own click puts it inside the chip's name, which a
 * browser never does with an uneditable chip.)
 */
export async function typeAtEnd(field: HTMLElement, text: string): Promise<void> {
  await userEvent.click(field);
  act(() => placeEditorCaret(field, editorText(field).length));
  await userEvent.type(field, text, { skipClick: true });
}
