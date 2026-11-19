import { blockSignature, type ComposerBlock, type ComposerToken } from "@ace/ui-core";
import { readEditor, type ChipToken } from "./editor-read.ts";

/*
 * The editor's DOM for the blocks the person sees: one `<div data-line>` per line with its style
 * on data attributes (a list item's bullet or number is drawn by CSS from `data-glyph`, never
 * text), `<strong>` around bold words, and an empty slot per chip, which React fills. No
 * Markdown syntax is ever in the DOM. Browser I/O stays here.
 */

export type Slot = { node: HTMLElement; token: ComposerToken };

const bullets = ["•", "◦", "▪"];

function lineElement(doc: Document, block: ComposerBlock): HTMLElement {
  const line = doc.createElement("div");
  line.dataset.line = "";
  const style = block.style;
  if (style.kind === "heading") line.dataset.md = `h${style.level}`;
  if (style.kind === "code") line.dataset.md = "code";
  if (style.kind === "item") {
    line.dataset.md = "item";
    line.dataset.indent = String(style.indent);
    line.dataset.marker = style.marker;
    line.dataset.depth = String(style.depth);
    line.dataset.glyph = /\d/.test(style.marker)
      ? style.marker
      : (bullets[(style.depth - 1) % bullets.length] ?? "•");
    line.style.setProperty("--depth", String(style.depth));
  }
  return line;
}

/** Draw `blocks` as the editor's children; the chip slots, in order. */
export function renderEditor(el: HTMLElement, blocks: readonly ComposerBlock[]): Slot[] {
  const doc = el.ownerDocument;
  const slots: Slot[] = [];
  const children = blocks.map((block) => {
    const line = lineElement(doc, block);
    let strong: HTMLElement | undefined;
    for (const run of block.runs) {
      let node: Node;
      if (run.type === "chip") {
        const chip = doc.createElement("span");
        chip.contentEditable = "false";
        chip.dataset.tokenText = run.text;
        if (run.token) {
          chip.setAttribute("aria-label", run.token.label);
          slots.push({ node: chip, token: run.token });
        }
        node = chip;
      } else if (run.text) node = doc.createTextNode(run.text);
      else continue;
      if (!run.bold) {
        strong = undefined;
        line.append(node);
        continue;
      }
      if (!strong) {
        strong = doc.createElement("strong");
        line.append(strong);
      }
      strong.append(node);
    }
    // An empty line keeps a break, so it has height and a place for the caret.
    if (!line.childNodes.length) line.append(doc.createElement("br"));
    return line;
  });
  el.replaceChildren(...children);
  return slots;
}

/**
 * Whether the editor already shows `blocks` exactly as `renderEditor` draws them, so it is left
 * alone and the browser's own editing (caret, selection, IME) is never disturbed.
 */
export function editorShows(
  el: HTMLElement,
  blocks: readonly ComposerBlock[],
  chipToken?: ChipToken,
): boolean {
  const read = readEditor(el, chipToken);
  return read.clean && blockSignature(read.blocks) === blockSignature(blocks);
}
