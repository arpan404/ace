import {
  chipSignature,
  decorationMarks,
  styleSignature,
  type ComposerToken,
  type DecorationNode,
} from "@ace/ui-core";

/*
 * The editor's DOM for a drawing (`decorateComposerText`): text nodes, a span per style
 * (`data-md`) and an empty slot per chip, which React fills. Browser I/O stays here.
 */

export type Slot = { node: HTMLElement; token: ComposerToken };

function build(
  doc: Document,
  nodes: readonly DecorationNode[],
  text: string,
  tokens: readonly ComposerToken[],
  slots: Slot[],
): Node[] {
  return nodes.flatMap((node): Node[] => {
    if (node.type === "text")
      return node.end > node.start ? [doc.createTextNode(text.slice(node.start, node.end))] : [];
    if (node.type === "token") {
      const token = tokens[node.index];
      if (!token) return [];
      const chip = doc.createElement("span");
      chip.contentEditable = "false";
      chip.dataset.tokenText = text.slice(token.start, token.end);
      chip.setAttribute("aria-label", token.label);
      slots.push({ node: chip, token });
      return [chip];
    }
    const span = doc.createElement("span");
    span.dataset.md = node.kind;
    if (node.depth !== undefined) span.dataset.depth = String(node.depth);
    span.append(...build(doc, node.children, text, tokens, slots));
    return [span];
  });
}

/** Draw `nodes` as the editor's children; the chip slots, in order. */
export function renderEditor(
  el: HTMLElement,
  nodes: readonly DecorationNode[],
  text: string,
  tokens: readonly ComposerToken[],
): Slot[] {
  const slots: Slot[] = [];
  const children = build(el.ownerDocument, nodes, text, tokens, slots);
  // A final newline draws no line of its own: the break after it is the line the caret sits on.
  if (text.endsWith("\n")) {
    const tail = el.ownerDocument.createElement("br");
    tail.dataset.editorTail = "";
    children.push(tail);
  }
  el.replaceChildren(...children);
  return slots;
}

/** One node of the editor in signature form; see `editorSignature`. */
function readSignature(node: Node, index: number): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement)) return "";
  if (node.dataset.editorTail !== undefined) return "";
  if (node.dataset.tokenText !== undefined) return chipSignature(node.dataset.tokenText);
  if (node.nodeName === "BR") return "\n";
  const inner = [...node.childNodes].map(readSignature).join("");
  const kind = node.dataset.md;
  if (kind !== undefined && node.nodeName === "SPAN")
    return (
      styleSignature(kind, node.dataset.depth ? Number(node.dataset.depth) : undefined) +
      inner +
      decorationMarks.close
    );
  const block = index > 0 && /^(DIV|P)$/.test(node.tagName) ? "\n" : "";
  return `${block}${styleSignature(`?${node.tagName}`, undefined)}${inner}${decorationMarks.close}`;
}

/**
 * What the editor shows, in the signature `decorationSignature` gives a drawing, read as
 * `editorText` reads the text. Anything the browser added on its own (a `<b>`, a `<div>`) reads
 * as a style no drawing has, so the editor is drawn again.
 */
export function editorSignature(el: HTMLElement): string {
  if (el.childNodes.length === 1 && el.firstChild?.nodeName === "BR") return "";
  return [...el.childNodes].map(readSignature).join("");
}

/** Styles whose marks show while the caret is in them, and fade once it leaves. */
const live = new Set(["bold", "h1", "h2", "h3"]);

/** Mark the styles the caret is in (`data-active`), so their Markdown marks show. */
export function markActiveStyles(el: HTMLElement): void {
  const selection = el.ownerDocument.getSelection();
  const focus = selection?.focusNode;
  const active = new Set<HTMLElement>();
  if (focus && el.contains(focus))
    for (let at: Node | null = focus; at && at !== el; at = at.parentNode)
      if (at instanceof HTMLElement && live.has(at.dataset.md ?? "")) active.add(at);
  for (const node of el.querySelectorAll<HTMLElement>("[data-active]"))
    if (!active.has(node)) delete node.dataset.active;
  for (const node of active) node.dataset.active = "";
}
