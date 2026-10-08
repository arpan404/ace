/** Text and caret offsets exclude chip decoration. Browser I/O stays here. */
export function editorText(node: Node): string {
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
