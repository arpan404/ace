import {
  boldSpans,
  composerBlocks,
  emptyBlock,
  offsetPoint,
  pointOffset,
  serializeBlocks,
  type BlockPoint,
  type BlockRun,
  type BlockStyle,
  type ComposerBlock,
} from "./composer-blocks.ts";
import { composerLines, lineAt } from "./composer-lines.ts";
import { continueList, indentList, renumberEdits } from "./composer-lists.ts";
import {
  applyTextChange,
  applyTextEdits,
  mapTextOffset,
  mapTextTokens,
  type TextSelection,
} from "./composer-text-edits.ts";
import type { ComposerToken } from "./composer-tokens.ts";

/*
 * Edits the composer makes on what the person sees, written back as Markdown: a line broken in
 * two (a list carried on), a heading or bullet taken off a line, words typed bold or plain at a
 * bare caret. Made on blocks, so bold words split cleanly and no `**` is ever left showing. Pure.
 */

/** The message after an edit, and where the caret goes. */
export interface ComposerEdited {
  text: string;
  tokens: readonly ComposerToken[];
  caret: number;
}

/** A run cut at `offset`: what goes before and what goes after. */
function cut(run: BlockRun, offset: number): [BlockRun[], BlockRun[]] {
  if (run.type === "chip") return offset > 0 ? [[run], []] : [[], [run]];
  const head = run.text.slice(0, offset);
  const tail = run.text.slice(offset);
  return [head ? [{ ...run, text: head }] : [], tail ? [{ ...run, text: tail }] : []];
}

/** A line's runs on either side of `point`. */
function split(block: ComposerBlock, point: BlockPoint): [BlockRun[], BlockRun[]] {
  const before = block.runs.slice(0, point.run);
  const after = block.runs.slice(point.run + 1);
  const run = block.runs[point.run];
  if (!run) return [block.runs, []];
  const [head, tail] = cut(run, point.offset);
  return [
    [...before, ...head],
    [...tail, ...after],
  ];
}

/** The visible words between two points taken out, the lines they span joined. */
function removeBetween(
  blocks: readonly ComposerBlock[],
  from: BlockPoint,
  to: BlockPoint,
): { blocks: ComposerBlock[]; at: BlockPoint } {
  const first = blocks[from.line];
  const last = blocks[to.line];
  if (!first || !last) return { blocks: [...blocks], at: from };
  const [head] = split(first, from);
  const [, tail] = split(last, to);
  const joined: ComposerBlock = { style: first.style, runs: [...head, ...tail] };
  return {
    blocks: [...blocks.slice(0, from.line), joined, ...blocks.slice(to.line + 1)],
    at: { line: from.line, run: head.length, offset: 0 },
  };
}

function written(blocks: readonly ComposerBlock[], line: number): ComposerEdited {
  const serialized = serializeBlocks(blocks);
  return {
    text: serialized.text,
    tokens: serialized.tokens,
    caret: pointOffset(serialized, { line, run: 0, offset: 0 }),
  };
}

const nextMarker = (marker: string) => {
  const number = /^(\d+)([.)])$/.exec(marker);
  return number ? `${Number(number[1]) + 1}${number[2] ?? "."}` : marker;
};

/**
 * The newline key: the line breaks at the caret (the selection taken out first). In a list item
 * with words the next item starts; an empty item ends the list or steps out a level; anywhere
 * else the new line is plain words. Bold words broken in two stay bold on both lines.
 */
export function breakLine(
  text: string,
  tokens: readonly ComposerToken[],
  selection: TextSelection,
): ComposerEdited {
  let blocks = composerBlocks(text, tokens);
  let serialized = serializeBlocks(blocks);
  let point = offsetPoint(blocks, serialized, selection.start);
  if (selection.end !== selection.start) {
    const removed = removeBetween(blocks, point, offsetPoint(blocks, serialized, selection.end));
    blocks = removed.blocks;
    point = removed.at;
    serialized = serializeBlocks(blocks);
  }
  const block = blocks[point.line];
  if (!block) return { text, tokens, caret: selection.start };
  if (block.style.kind === "item" && emptyBlock(block)) {
    // An empty item: the list ends here, or the item steps out a level.
    const caret = pointOffset(serialized, point);
    const ended = continueList(serialized.text, { start: caret, end: caret });
    if (ended) {
      const after = applyTextChange(serialized.text, serialized.tokens, ended);
      return { text: after.text, tokens: after.tokens, caret: after.selection.start };
    }
  }
  const [head, tail] = split(block, point);
  const style: BlockStyle =
    block.style.kind === "item"
      ? { ...block.style, marker: nextMarker(block.style.marker) }
      : { kind: "plain" };
  const next = [
    ...blocks.slice(0, point.line),
    { style: block.style, runs: head },
    { style, runs: tail },
    ...blocks.slice(point.line + 1),
  ];
  const made = written(next, point.line + 1);
  if (style.kind !== "item") return made;
  // The items after the new one count on from it.
  const numbers = renumberEdits(made.text, new Set(), { start: made.caret, end: made.caret });
  return {
    text: applyTextEdits(made.text, numbers),
    tokens: mapTextTokens(made.tokens, numbers),
    caret: mapTextOffset(made.caret, numbers),
  };
}

/**
 * Backspace at the start of a heading or list item's words: the heading goes back to plain
 * words, a nested item steps out a level, a top-level item loses its bullet. Undefined on a
 * plain line, where Backspace joins it to the line before as usual.
 */
export function clearLineStyle(
  text: string,
  tokens: readonly ComposerToken[],
  line: number,
): ComposerEdited | undefined {
  const blocks = composerBlocks(text, tokens);
  const block = blocks[line];
  if (!block || (block.style.kind !== "heading" && block.style.kind !== "item")) return undefined;
  if (block.style.kind === "item" && block.style.depth > 1) {
    const at = composerLines(text)[line];
    if (at?.kind !== "item") return undefined;
    const out = indentList(text, { start: at.content, end: at.content }, true);
    if (!out) return undefined;
    const after = applyTextChange(text, tokens, out);
    return { text: after.text, tokens: after.tokens, caret: after.selection.start };
  }
  const next = blocks.map((each, index) =>
    index === line ? { style: { kind: "plain" as const }, runs: each.runs } : each,
  );
  return written(next, line);
}

/** The bold run around `caret`, between its marks (both edges included); undefined outside bold. */
function boldAround(text: string, tokens: readonly ComposerToken[], caret: number) {
  const line = lineAt(composerLines(text), caret);
  const words = line.kind === "heading" || line.kind === "item" ? line.content : line.start;
  if (line.kind === "code") return undefined;
  return boldSpans(text, words, line.end, tokens).find(
    (span) => caret >= span.start + 2 && caret <= span.end - 2,
  );
}

/** Whether what is typed at `caret` lands in bold words. */
export function boldAt(text: string, tokens: readonly ComposerToken[], caret: number): boolean {
  return boldAround(text, tokens, caret) !== undefined;
}

/**
 * `typed` put in at `caret` bold (or plain, `bold` false) whatever the words around it are: the
 * way ⌘B at a bare caret sets what is typed next. Joins bold words it touches rather than
 * writing a second pair of marks beside them.
 */
export function typeStyled(
  text: string,
  tokens: readonly ComposerToken[],
  caret: number,
  typed: string,
  bold: boolean,
): ComposerEdited {
  const insert = (at: number, words: string, after: number): ComposerEdited => {
    const edits = [{ start: at, end: at, insert: words }];
    return {
      text: applyTextEdits(text, edits),
      tokens: mapTextTokens(tokens, edits),
      caret: after,
    };
  };
  const around = boldAround(text, tokens, caret);
  if (bold) {
    if (around || !typed.trim()) return insert(caret, typed, caret + typed.length);
    const line = lineAt(composerLines(text), caret);
    const words = line.kind === "heading" || line.kind === "item" ? line.content : line.start;
    const spans = line.kind === "code" ? [] : boldSpans(text, words, line.end, tokens);
    const ending = spans.find((span) => span.end === caret);
    if (ending) return insert(ending.end - 2, typed, ending.end - 2 + typed.length);
    const starting = spans.find((span) => span.start === caret);
    if (starting) return insert(starting.start + 2, typed, starting.start + 2 + typed.length);
    return insert(caret, `**${typed}**`, caret + 2 + typed.length);
  }
  if (!around) return insert(caret, typed, caret + typed.length);
  if (caret === around.end - 2) return insert(around.end, typed, around.end + typed.length);
  if (caret === around.start + 2) return insert(around.start, typed, around.start + typed.length);
  return insert(caret, `**${typed}**`, caret + 2 + typed.length);
}
