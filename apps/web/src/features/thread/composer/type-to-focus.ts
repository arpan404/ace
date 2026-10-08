import { editorText, placeEditorCaret } from "./editor-dom.ts";
/** Where typing belongs to something else: a field, an editor, a menu or a dialog. */
const owned =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="menu"], [role="menuitem"], [role="listbox"], [role="dialog"], [role="alertdialog"], [role="combobox"], .xterm';

/** A key that types a character, not a shortcut or a navigation key. */
export function printable(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">) {
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
}

/**
 * Type-to-focus (UX audit CMP-2): a printable key pressed while focus is on the page itself or
 * the transcript (not in a field, menu or dialog) moves focus to `input` before the key lands,
 * so the character is written there. Returns a stop.
 */
export function listenTypeToFocus(input: {
  readonly current: HTMLDivElement | HTMLTextAreaElement | null;
}) {
  const onKey = (event: KeyboardEvent) => {
    const el = input.current;
    if (
      !el ||
      (el instanceof HTMLTextAreaElement ? el.disabled : el.contentEditable === "false") ||
      event.defaultPrevented ||
      !printable(event)
    )
      return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(owned)) return;
    // A dialog or menu that's open elsewhere keeps the keys even when focus drifted out.
    if (document.querySelector('[role="dialog"][data-open], [role="menu"][data-open]')) return;
    el.focus();
    if (el instanceof HTMLTextAreaElement) el.setSelectionRange(el.value.length, el.value.length);
    else placeEditorCaret(el, editorText(el).length);
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
}
