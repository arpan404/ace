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
/** Styles a caret at their end stays out of: what is typed there follows them, plain. */
const closedStyles = new Set(["mark", "bold", "bullet", "number", "indent"]);

/** Whether `node` is the last thing drawn inside a style typing at its end leaves. */
function endsClosedStyle(el: HTMLElement, node: Node): boolean {
  for (let at: Node | null = node; at && at !== el; at = at.parentNode) {
    if (at.nextSibling) return false;
    const parent = at.parentNode;
    if (parent instanceof HTMLElement && closedStyles.has(parent.dataset.md ?? "")) return true;
  }
  return false;
}

/** Set one end of `range` at text offset `position` of the editor; false past its end. */
function setBoundary(el: HTMLElement, range: Range, position: number, end: boolean): boolean {
  let left = position;
  const set = (node: Node, offset: number) => {
    if (end) range.setEnd(node, offset);
    else range.setStart(node, offset);
  };
  const around = (node: Node, before: boolean) => {
    if (end && before) range.setEndBefore(node);
    else if (end) range.setEndAfter(node);
    else if (before) range.setStartBefore(node);
    else range.setStartAfter(node);
  };
  const locate = (node: Node): boolean => {
    if (node instanceof HTMLElement && node.dataset.tokenText !== undefined) {
      const length = node.dataset.tokenText.length;
      if (left <= length) {
        around(node, left === 0);
        return true;
      }
      left -= length;
      return false;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      // At the end of bold words or a marker, the caret goes on to what follows them.
      if (left < length || (left === length && !endsClosedStyle(el, node))) {
        set(node, left);
        return true;
      }
      left -= length;
      return false;
    }
    for (const child of node.childNodes) if (locate(child)) return true;
    return false;
  };
  return locate(el);
}

export function placeEditorCaret(el: HTMLElement, position: number): void {
  placeEditorSelection(el, position, position);
}

/** Select text offsets `[start, end)` of the editor; a caret when they're equal. */
export function placeEditorSelection(el: HTMLElement, start: number, end: number): void {
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const tail = range.cloneRange();
  if (!setBoundary(el, range, start, false)) range.setStart(tail.endContainer, tail.endOffset);
  if (start === end) range.collapse(true);
  else if (!setBoundary(el, range, end, true)) range.setEnd(tail.endContainer, tail.endOffset);
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

/** Each chip still in the editor, in order, with where its text starts. */
export function editorChips(el: HTMLElement): { node: HTMLElement; start: number }[] {
  return [...el.querySelectorAll<HTMLElement>("[data-token-text]")].map((node) => {
    const before = el.ownerDocument.createRange();
    before.selectNodeContents(el);
    before.setEndBefore(node);
    return { node, start: editorText(before.cloneContents()).length };
  });
}
