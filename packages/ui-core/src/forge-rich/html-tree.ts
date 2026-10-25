import type { HtmlPiece } from "./html-pieces.ts";
import { safeElement, allowedTag } from "./html-policy.ts";

/*
 * One tree from a run of sibling markdown tokens where some are raw HTML (ADR 0096). GitHub lets
 * an element opened in one block hold the blocks after it until it closes (`<details>`, a
 * blank line, a code block, `</details>`), and inline tags wrap the inline tokens between them,
 * so the run is read as a whole: allowed tags open and close elements across tokens, the
 * markdown tokens between them become their children, and a tag that isn't allowed is kept as
 * its source text. An end tag closes the nearest open element of its name (and any opened
 * inside it); one with nothing to close is dropped. Elements still open at the end close there.
 */

export type HtmlNode =
  | { kind: "element"; tag: string; attrs: Readonly<Record<string, string>>; children: HtmlNode[] }
  | { kind: "text"; text: string }
  /** A markdown token of the run, by its index, drawn by the renderer. */
  | { kind: "token"; index: number };

/** One entry of a run: an HTML token's pieces, or a markdown token left to the renderer. */
export type RunEntry =
  | { kind: "html"; pieces: readonly HtmlPiece[] }
  | { kind: "token"; index: number };

export function htmlTree(run: readonly RunEntry[], host: string): HtmlNode[] {
  const root: HtmlNode[] = [];
  const open: { tag: string; children: HtmlNode[] }[] = [];
  const children = () => open.at(-1)?.children ?? root;
  const text = (value: string) => {
    if (!value) return;
    const list = children();
    const last = list.at(-1);
    if (last?.kind === "text") list[list.length - 1] = { kind: "text", text: last.text + value };
    else list.push({ kind: "text", text: value });
  };
  for (const entry of run) {
    if (entry.kind === "token") {
      children().push({ kind: "token", index: entry.index });
      continue;
    }
    for (const piece of entry.pieces) {
      if (piece.kind === "comment") continue;
      if (piece.kind === "text") {
        text(piece.text);
        continue;
      }
      if (piece.kind === "close") {
        if (!allowedTag(piece.tag)) {
          text(piece.raw);
          continue;
        }
        const at = open.findLastIndex((element) => element.tag === piece.tag);
        if (at >= 0) open.length = at;
        continue;
      }
      const element = safeElement(piece.tag, piece.attrs, host);
      if (!element) {
        text(piece.raw);
        continue;
      }
      const node: HtmlNode = {
        kind: "element",
        tag: element.tag,
        attrs: element.attrs,
        children: [],
      };
      children().push(node);
      // As in a browser, `/>` closes only void elements.
      if (!element.void) open.push({ tag: element.tag, children: node.children });
    }
  }
  return root;
}
