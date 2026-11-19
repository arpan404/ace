import type { BlockPoint, BlockRun, BlockStyle, ComposerBlock, ComposerToken } from "@ace/ui-core";

/*
 * The editor's DOM read back as blocks (`composerBlocks`): one line element per line, its style
 * on its data attributes, `<strong>` for bold, a span per chip. Whatever the browser did while
 * typing (a line merged into another, text split across nodes, a line break in pasted words) is
 * read as what it shows; anything that isn't the editor's own drawing marks the read not
 * `clean`, so the editor is drawn again. Browser I/O stays here.
 */

/** A run as the DOM holds it: the node, and where the run starts in a text node. */
export interface ReadRun {
  node: Node;
  line: number;
  run: number;
  from: number;
  length: number;
  bold: boolean;
}

export interface EditorRead {
  blocks: ComposerBlock[];
  runs: ReadRun[];
  /** Each line's element; null for a line the browser made outside one. */
  lines: (HTMLElement | null)[];
  /** The DOM is exactly the editor's own drawing of these blocks. */
  clean: boolean;
}

/** A chip's token, or undefined for a chip this editor never made (a dropped copy). */
export type ChipToken = (node: HTMLElement) => ComposerToken | undefined;

function styleOf(line: HTMLElement): BlockStyle {
  const kind = line.dataset.md;
  if (kind === "h1" || kind === "h2" || kind === "h3")
    return { kind: "heading", level: kind === "h1" ? 1 : kind === "h2" ? 2 : 3 };
  if (kind === "item")
    return {
      kind: "item",
      indent: Number(line.dataset.indent ?? 0) || 0,
      marker: line.dataset.marker ?? "-",
      depth: Number(line.dataset.depth ?? 1) || 1,
    };
  if (kind === "code") return { kind: "code" };
  return { kind: "plain" };
}

const isChip = (node: Node): boolean =>
  node instanceof HTMLElement && node.dataset.tokenText !== undefined;

/** Whether a break is a line's placeholder: nothing drawn after it in its line. */
function placeholder(node: Node): boolean {
  for (let next = node.nextSibling; next; next = next.nextSibling)
    if (next.nodeType !== Node.TEXT_NODE || next.textContent) return false;
  return true;
}

export function readEditor(el: HTMLElement, chipToken?: ChipToken): EditorRead {
  const blocks: ComposerBlock[] = [];
  const runs: ReadRun[] = [];
  const lines: (HTMLElement | null)[] = [];
  let clean = true;
  let open = false;
  const start = (style: BlockStyle, element: HTMLElement | null) => {
    blocks.push({ style, runs: [] });
    lines.push(element);
    open = true;
  };
  const add = (run: BlockRun, node: Node, from: number, length: number) => {
    // Words the browser put outside any line make a line of their own.
    if (!open) {
      clean = false;
      start({ kind: "plain" }, null);
    }
    const line = blocks.length - 1;
    const block = blocks[line];
    if (!block) return;
    runs.push({ node, line, run: block.runs.length, from, length, bold: run.bold });
    block.runs.push(run);
  };
  const inline = (node: Node, bold: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const words = node.textContent ?? "";
      const parts = words.split("\n");
      let from = 0;
      parts.forEach((part, index) => {
        if (index > 0) {
          clean = false;
          start({ kind: "plain" }, null);
        }
        add({ type: "text", text: part, bold }, node, from, part.length);
        from += part.length + 1;
      });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.tokenText !== undefined) {
      const token = chipToken?.(node);
      if (chipToken && !token) {
        clean = false;
        return;
      }
      add({ type: "chip", text: node.dataset.tokenText ?? "", bold, token }, node, 0, 1);
      return;
    }
    if (node.nodeName === "BR") {
      if (node.dataset.editorTail !== undefined || placeholder(node)) return;
      clean = false;
      start({ kind: "plain" }, null);
      return;
    }
    const strong = node.nodeName === "STRONG" || node.nodeName === "B";
    if (!strong || node.nodeName === "B" || bold) clean = false;
    for (const child of node.childNodes) inline(child, bold || strong);
  };
  // Chromium leaves a lone break after the last character is deleted: no words at all.
  const only = el.childNodes.length === 1 ? el.firstChild : null;
  if (!(only?.nodeName === "BR"))
    for (const child of el.childNodes) {
      if (child instanceof HTMLElement && /^(DIV|P)$/.test(child.tagName)) {
        if (child.dataset.line === undefined) clean = false;
        start(styleOf(child), child);
        for (const node of child.childNodes) inline(node, false);
        open = false;
        continue;
      }
      if (child instanceof HTMLElement && child.dataset.editorTail !== undefined) continue;
      if (child.nodeName === "BR") {
        clean = false;
        if (!open) start({ kind: "plain" }, null);
        open = false;
        continue;
      }
      inline(child, false);
    }
  // Even an empty editor draws its one line, so the first words typed land in it.
  if (!blocks.length) {
    start({ kind: "plain" }, null);
    clean = false;
  }
  return { blocks, runs, lines, clean };
}

/** The `<strong>` a run's node is in, if it is bold. */
function strongOf(run: ReadRun): Node | null {
  for (let at = run.node.parentNode; at; at = at.parentNode)
    if (at.nodeName === "STRONG" || at.nodeName === "B") return at;
  return null;
}

const endOf = (run: ReadRun): BlockPoint => ({ line: run.line, run: run.run, offset: run.length });
const startOf = (run: ReadRun): BlockPoint => ({ line: run.line, run: run.run, offset: 0 });

/** The visible position a DOM boundary point is at. */
export function pointAt(read: EditorRead, container: Node, offset: number): BlockPoint {
  const own = read.runs.filter((run) => run.node === container);
  if (own.length) {
    const run = own.findLast((each) => offset >= each.from) ?? own[0];
    if (run)
      return { line: run.line, run: run.run, offset: Math.min(run.length, offset - run.from) };
  }
  // Inside a chip's own drawing: after the chip.
  const chip = read.runs.find((run) => isChip(run.node) && run.node.contains(container));
  if (chip) return endOf(chip);
  const doc = container.ownerDocument ?? document;
  const range = doc.createRange();
  range.setStart(container, offset);
  let prev: ReadRun | undefined;
  let next: ReadRun | undefined;
  for (const run of read.runs) {
    if (range.comparePoint(run.node, isChip(run.node) ? 0 : run.from) >= 0) {
      next = run;
      break;
    }
    prev = run;
  }
  if (!next || !prev) {
    if (next) return startOf(next);
    if (prev) {
      // Past the last words, on a line of its own (an empty last line): that line.
      const line = lineOf(read, container, offset);
      return line !== undefined && line > prev.line ? { line, run: 0, offset: 0 } : endOf(prev);
    }
    return { line: lineOf(read, container, offset) ?? 0, run: 0, offset: 0 };
  }
  if (prev.line !== next.line) {
    const line = lineOf(read, container, offset);
    if (line === next.line) return startOf(next);
    if (line !== undefined && line !== prev.line) return { line, run: 0, offset: 0 };
    return endOf(prev);
  }
  // Still inside the bold words: their end, so what is typed carries them on.
  const strong = strongOf(prev);
  if (prev.bold && strong && strong.contains(container)) return endOf(prev);
  return startOf(next);
}

/** Which line a boundary point is in, by the line elements around it. */
function lineOf(read: EditorRead, container: Node, offset: number): number | undefined {
  const index = read.lines.findIndex(
    (line) => line && (line === container || line.contains(container)),
  );
  if (index !== -1) return index;
  const child = container.childNodes[offset];
  if (child) {
    const at = read.lines.indexOf(child instanceof HTMLElement ? child : null);
    if (at !== -1) return at;
  }
  if (offset >= container.childNodes.length) return read.lines.length - 1;
  return undefined;
}

/** Where a visible position is in the DOM, as a boundary point. */
export function domAt(
  read: EditorRead,
  el: HTMLElement,
  point: BlockPoint,
): { node: Node; offset: number } {
  const run = read.runs.find((each) => each.line === point.line && each.run === point.run);
  if (run && isChip(run.node)) {
    const parent = run.node.parentNode ?? el;
    const index = [...parent.childNodes].findIndex((child) => child === run.node);
    return { node: parent, offset: index + (point.offset > 0 ? 1 : 0) };
  }
  if (run) return { node: run.node, offset: run.from + Math.min(point.offset, run.length) };
  const line = read.lines[point.line];
  if (line) return { node: line, offset: 0 };
  return { node: el, offset: el.childNodes.length };
}
