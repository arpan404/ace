/** Text and caret offsets exclude chip decoration. Browser I/O stays here. */
export function editorText(node: Node): string {
  // Chromium leaves a single filler break after deleting the final character.
  // It keeps the caret line alive, but is not an authored newline.
  if (
    node instanceof HTMLElement &&
    node.isContentEditable &&
    node.childNodes.length === 1 &&
    node.firstChild?.nodeName === "BR"
  )
    return "";
  if (node instanceof HTMLElement && node.dataset.editorTail !== undefined) return "";
  if (node instanceof HTMLElement && node.dataset.tokenText !== undefined)
    return node.dataset.tokenText;
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeName === "BR") return "\n";
  return [...node.childNodes]
    .map((child, index) => {
      const text = editorText(child);
      return index > 0 && child instanceof HTMLElement && /^(DIV|P)$/.test(child.tagName)
        ? `\n${text}`
        : text;
    })
    .join("");
}
export function editorCaret(el: HTMLElement): number {
  const selection = el.ownerDocument.getSelection();
  if (!selection?.focusNode || !el.contains(selection.focusNode)) return editorText(el).length;
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  range.setEnd(selection.focusNode, selection.focusOffset);
  return editorText(range.cloneContents()).length;
}
export function placeEditorCaret(el: HTMLElement, position: number): void {
  const range = el.ownerDocument.createRange();
  let left = position;
  const locate = (node: Node): boolean => {
    if (node instanceof HTMLElement && node.dataset.tokenText !== undefined) {
      const length = node.dataset.tokenText.length;
      if (left <= length) {
        if (left === 0) range.setStartBefore(node);
        else range.setStartAfter(node);
        return true;
      }
      left -= length;
      return false;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      if (left <= length) {
        range.setStart(node, left);
        return true;
      }
      left -= length;
      return false;
    }
    for (const child of node.childNodes) if (locate(child)) return true;
    return false;
  };
  if (!locate(el)) {
    range.selectNodeContents(el);
    range.collapse(false);
  }
  range.collapse(true);
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

/** The text each chip in the editor stands for, in document order. */
export function editorTokenTexts(el: HTMLElement): string[] {
  return [...el.querySelectorAll<HTMLElement>("[data-token-text]")].map(
    (node) => node.dataset.tokenText ?? "",
  );
}

export function editorSelection(el: HTMLElement): { start: number; end: number } {
  const selection = el.ownerDocument.getSelection();
  if (!selection?.rangeCount) return { start: editorText(el).length, end: editorText(el).length };
  const selected = selection.getRangeAt(0);
  if (!el.contains(selected.startContainer) || !el.contains(selected.endContainer))
    return { start: editorText(el).length, end: editorText(el).length };
  const before = el.ownerDocument.createRange();
  before.selectNodeContents(el);
  before.setEnd(selected.startContainer, selected.startOffset);
  const start = editorText(before.cloneContents()).length;
  before.setEnd(selected.endContainer, selected.endOffset);
  return { start, end: editorText(before.cloneContents()).length };
}
