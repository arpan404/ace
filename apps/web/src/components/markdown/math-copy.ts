import type { ClipboardEvent } from "react";

/*
 * Copying prose that holds rendered math. KaTeX's output is two trees (visual
 * HTML and hidden MathML), so the browser's own copy doubles every formula
 * and loses its TeX. When a selection touches a formula, the selection widens
 * to whole formulas and each one is copied as the TeX the agent wrote, with
 * its original delimiters (`data-tex-source`, set by `Formula`). Selections
 * without math keep the browser's copy untouched.
 */

const SOURCE = "data-tex-source";

/** Blocks that end a line in copied text; paragraphs and headings leave a blank line. */
const lineBlocks = new Set(["DIV", "LI", "TR", "UL", "OL", "TABLE"]);
const paragraphBlocks = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "BLOCKQUOTE"]);

function formulaOf(node: Node): Element | null {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return element?.closest(`[${SOURCE}]`) ?? null;
}

function appendText(node: Node, out: string[]): void {
  if (node.nodeType === 3) {
    out.push(node.textContent ?? "");
    return;
  }
  if (node.nodeType !== 1 && node.nodeType !== 11) return;
  const tag = node.nodeType === 1 ? (node as Element).tagName : "";
  if (tag === "BR") {
    out.push("\n");
    return;
  }
  for (const child of node.childNodes) appendText(child, out);
  if (paragraphBlocks.has(tag)) out.push("\n\n");
  else if (lineBlocks.has(tag)) out.push("\n");
}

/** Copied plain text for `fragment`, each rendered formula replaced by its TeX source. */
export function texSourceText(fragment: DocumentFragment): string {
  for (const formula of fragment.querySelectorAll(`[${SOURCE}]`))
    formula.replaceWith(formula.getAttribute(SOURCE) ?? "");
  const out: string[] = [];
  appendText(fragment, out);
  return out
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** `onCopy` for a prose root: puts formulas' TeX on the clipboard, never their glyphs. */
export function copyTexSource(event: ClipboardEvent<HTMLElement>): void {
  const selection = event.currentTarget.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0).cloneRange();
  const start = formulaOf(range.startContainer);
  if (start) range.setStartBefore(start);
  const end = formulaOf(range.endContainer);
  if (end) range.setEndAfter(end);
  const fragment = range.cloneContents();
  if (!fragment.querySelector(`[${SOURCE}]`)) return;
  event.clipboardData.setData("text/plain", texSourceText(fragment));
  event.preventDefault();
}
