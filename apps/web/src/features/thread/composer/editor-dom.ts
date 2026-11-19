import { offsetPoint, pointOffset, serializeBlocks } from "@ace/ui-core";
import { domAt, pointAt, readEditor } from "./editor-read.ts";

/*
 * The editor's words and caret in Markdown terms: the DOM shows only what the person sees, and
 * every offset here is one in the Markdown that is sent (`composer-blocks.ts`). Browser I/O.
 */

/** The Markdown the editor shows. */
export function editorText(el: HTMLElement): string {
  return serializeBlocks(readEditor(el).blocks).text;
}

/** Where a DOM boundary point is in the Markdown. */
function offsetOf(el: HTMLElement, node: Node, offset: number): number {
  const read = readEditor(el);
  return pointOffset(serializeBlocks(read.blocks), pointAt(read, node, offset));
}

export function editorCaret(el: HTMLElement): number {
  const selection = el.ownerDocument.getSelection();
  if (!selection?.focusNode || !el.contains(selection.focusNode)) return editorText(el).length;
  return offsetOf(el, selection.focusNode, selection.focusOffset);
}

export function editorSelection(el: HTMLElement): { start: number; end: number } {
  const selection = el.ownerDocument.getSelection();
  const read = readEditor(el);
  const written = serializeBlocks(read.blocks);
  const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
  if (!range || !el.contains(range.startContainer) || !el.contains(range.endContainer))
    return { start: written.text.length, end: written.text.length };
  return {
    start: pointOffset(written, pointAt(read, range.startContainer, range.startOffset)),
    end: pointOffset(written, pointAt(read, range.endContainer, range.endOffset)),
  };
}

/**
 * The line the caret is at the very start of the words of, if it is (a collapsed caret before
 * the first thing the line shows).
 */
export function editorLineStart(el: HTMLElement): number | undefined {
  const selection = el.ownerDocument.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
  if (!range?.collapsed || !el.contains(range.startContainer)) return undefined;
  const read = readEditor(el);
  const point = pointAt(read, range.startContainer, range.startOffset);
  const before = read.blocks[point.line]?.runs.slice(0, point.run) ?? [];
  const shown = before.some((run) => run.type === "chip" || run.text.length > 0);
  return !shown && point.offset === 0 ? point.line : undefined;
}

export function placeEditorCaret(el: HTMLElement, position: number): void {
  placeEditorSelection(el, position, position);
}

/** Select Markdown offsets `[start, end)` of the editor; a caret when they're equal. */
export function placeEditorSelection(el: HTMLElement, start: number, end: number): void {
  const read = readEditor(el);
  const written = serializeBlocks(read.blocks);
  const from = domAt(read, el, offsetPoint(read.blocks, written, start));
  const to = start === end ? from : domAt(read, el, offsetPoint(read.blocks, written, end));
  const range = el.ownerDocument.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  const selection = el.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * Put plain text where the selection is, replacing what it covers, then report it as typed
 * input so the composer reads it like any other edit.
 */
export function insertEditorText(el: HTMLElement, text: string): void {
  const selection = el.ownerDocument.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return;
  range.deleteContents();
  const node = el.ownerDocument.createTextNode(text);
  range.insertNode(node);
  // A trailing newline draws no line of its own: give the caret the tail break the editor
  // renders after a final newline, so the new empty line shows (and is measured) at once.
  if (text.endsWith("\n") && !followingContent(el, node)) {
    const tail = el.ownerDocument.createElement("br");
    tail.dataset.editorTail = "";
    el.append(tail);
  }
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Whether anything is drawn after `node` in the editor: text, a chip or a break. */
function followingContent(el: HTMLElement, node: Node): boolean {
  for (let at: Node | null = node; at && at !== el; at = at.parentNode)
    for (let next = at.nextSibling; next; next = next.nextSibling)
      if (next.nodeType !== Node.TEXT_NODE || next.textContent) return true;
  return false;
}
