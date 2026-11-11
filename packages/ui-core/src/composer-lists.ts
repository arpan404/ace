import {
  composerLines,
  lineAt,
  parentItem,
  previousSibling,
  type ComposerLine,
  type ItemLine,
} from "./composer-lines.ts";
import {
  applyTextEdits,
  mapTextOffset,
  type TextChange,
  type TextEdit,
  type TextSelection,
} from "./composer-text-edits.ts";

/*
 * Lists in the composer: the newline key continues one, Tab and Shift+Tab nest and un-nest its
 * items, and numbered items count up within each list at each level. Pure.
 */

const delimiter = (marker: string) => marker.at(-1) ?? ".";

/**
 * The edits that number each ordered list 1, 2, 3… from its first item. A list's first item
 * keeps the number it was given (a list may start at 5), unless its line is in `reset`, which
 * starts it at 1: a nested list made by Tab or Shift+Tab.
 */
export function renumberEdits(text: string, reset: ReadonlySet<number> = new Set()): TextEdit[] {
  const edits: TextEdit[] = [];
  // The last item seen at each indent of the open lists.
  const open: ItemLine[] = [];
  const counted = new Map<ItemLine, number>();
  for (const line of composerLines(text)) {
    if (line.kind !== "item") {
      open.length = 0;
      continue;
    }
    while (open.length && (open.at(-1)?.indent ?? 0) > line.indent) open.pop();
    const sibling = open.at(-1)?.indent === line.indent ? open.pop() : undefined;
    open.push(line);
    if (line.number === undefined) continue;
    const before = sibling && sibling.number !== undefined ? counted.get(sibling) : undefined;
    const wanted = before !== undefined ? before + 1 : reset.has(line.index) ? 1 : line.number;
    counted.set(line, wanted);
    if (wanted === line.number) continue;
    const start = line.start + line.indent;
    edits.push({
      start,
      end: start + line.marker.length - 1,
      insert: String(wanted),
    });
  }
  return edits;
}

/** A change made of `edits`, then the numbering they leave put right. */
function withNumbers(
  text: string,
  edits: TextEdit[],
  selection: (edits: TextEdit[]) => TextSelection,
  reset?: ReadonlySet<number>,
): TextChange {
  const after = applyTextEdits(text, edits);
  const numbers = renumberEdits(after, reset);
  const picked = selection(edits);
  return {
    steps: [edits, numbers],
    selection: {
      start: mapTextOffset(picked.start, numbers),
      end: mapTextOffset(picked.end, numbers),
    },
  };
}

/** What the newline key does in a list item with the caret in its words; undefined elsewhere. */
export function continueList(text: string, selection: TextSelection): TextChange | undefined {
  const lines = composerLines(text);
  const line = lineAt(lines, selection.start);
  if (line.kind !== "item" || selection.start < line.content || selection.end > line.end)
    return undefined;
  const left = text.slice(line.content, selection.start) + text.slice(selection.end, line.end);
  if (!left.trim()) {
    // An empty nested item steps out a level; an empty top-level one ends the list.
    if (line.depth > 1) return indentLines(text, lines, [line], true);
    return withNumbers(text, [{ start: line.start, end: line.end, insert: "" }], () => ({
      start: line.start,
      end: line.start,
    }));
  }
  const marker =
    line.number === undefined ? line.marker : `${line.number + 1}${delimiter(line.marker)}`;
  const insert = `\n${" ".repeat(line.indent)}${marker} `;
  const caret = selection.start + insert.length;
  return withNumbers(text, [{ start: selection.start, end: selection.end, insert }], () => ({
    start: caret,
    end: caret,
  }));
}

/**
 * Tab (or Shift+Tab, `outdent`) with the selection in list items: each item it touches nests
 * under the one before it (or moves out a level), taking its own nested items along. Undefined
 * when the selection starts outside a list, so Tab keeps its usual meaning there; a change with
 * no steps when the item can't move (the first item can't nest, a top-level one can't step out).
 */
export function indentList(
  text: string,
  selection: TextSelection,
  outdent: boolean,
): TextChange | undefined {
  const lines = composerLines(text);
  const first = lineAt(lines, selection.start);
  if (first.kind !== "item") return undefined;
  const last = lineAt(lines, selection.end);
  const touched = lines
    .slice(first.index, last.index + 1)
    .filter((line): line is ItemLine => line.kind === "item");
  const moved = indentLines(text, lines, touched, outdent);
  return moved.steps.length ? remap(moved, selection) : { steps: [], selection };
}

/** Carry the caller's selection through a move. */
function remap(change: TextChange, selection: TextSelection): TextChange {
  const [shift = [], numbers = []] = change.steps;
  const through = (offset: number) =>
    mapTextOffset(mapTextOffset(offset, shift, true), numbers, true);
  return {
    steps: change.steps,
    selection: { start: through(selection.start), end: through(selection.end) },
  };
}

function indentLines(
  text: string,
  lines: readonly ComposerLine[],
  touched: readonly ItemLine[],
  outdent: boolean,
): TextChange {
  const head = touched[0];
  const none = { steps: [], selection: { start: head?.start ?? 0, end: head?.start ?? 0 } };
  if (!head) return none;
  const target = outdent ? parentItem(lines, head) : previousSibling(lines, head);
  if (!target) return none;
  const delta = outdent
    ? target.indent - head.indent
    : target.indent + target.marker.length + 1 - head.indent;
  // The touched items, and the items nested under the last of them.
  const lastTouched = touched.at(-1) ?? head;
  const block: ItemLine[] = [];
  for (let at = head.index; at < lines.length; at++) {
    const line = lines[at];
    if (line?.kind !== "item") break;
    if (at > lastTouched.index && line.indent <= lastTouched.indent) break;
    if (line.indent >= head.indent) block.push(line);
  }
  const edits = block.map((line): TextEdit =>
    delta > 0
      ? { start: line.start, end: line.start, insert: " ".repeat(delta) }
      : { start: line.start, end: line.start + Math.min(-delta, line.indent), insert: "" },
  );
  // A list the move begins starts at 1: the moved items, and the item after them.
  const reset = new Set(block.map((line) => line.index));
  reset.add((block.at(-1)?.index ?? head.index) + 1);
  const caret = head.content;
  return withNumbers(
    text,
    edits,
    (made) => {
      const at = mapTextOffset(caret, made, true);
      return { start: at, end: at };
    },
    reset,
  );
}
