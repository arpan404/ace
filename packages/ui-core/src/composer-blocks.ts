import { composerLines } from "./composer-lines.ts";
import type { ComposerToken } from "./composer-tokens.ts";

/*
 * The composer's Markdown as the person sees it: one block per line, its style (a heading, a
 * list item, fenced code or plain words) and its visible runs (words, bold or not, and chips).
 * The `#`, `**`, `- ` and `1. ` that write those styles are never part of a run, so the editor
 * shows only what a run holds. `serializeBlocks` writes blocks back as the exact Markdown, and
 * says where every visible position sits in it, so the caret, chips and file offsets stay in
 * Markdown. Pure.
 */

export type BlockStyle =
  | { kind: "plain" }
  | { kind: "code" }
  | { kind: "heading"; level: 1 | 2 | 3 }
  /** `indent` spaces, then `marker` (`-`, `*`, `3.`, `3)`) and a space; `depth` 1 at the top. */
  | { kind: "item"; indent: number; marker: string; depth: number };

export type BlockRun =
  | { type: "text"; text: string; bold: boolean }
  /** A chip: one visible unit, written as `text` (its token's Markdown). */
  | { type: "chip"; text: string; bold: boolean; token?: ComposerToken | undefined };

export interface ComposerBlock {
  style: BlockStyle;
  runs: BlockRun[];
}

/** A visible position: in line `line`, run `run`, after `offset` of its characters (a chip: 0 or 1). */
export interface BlockPoint {
  line: number;
  run: number;
  offset: number;
}

/**
 * The `**bold**` runs in `[start, end)` of `text`, marks included. A `**` inside a chip is the
 * chip's own text and never opens or closes one.
 */
export function boldSpans(
  text: string,
  start: number,
  end: number,
  tokens: readonly ComposerToken[],
): { start: number; end: number }[] {
  let masked = text.slice(start, end);
  for (const token of tokens) {
    const from = Math.max(token.start, start);
    const to = Math.min(token.end, end);
    if (from < to)
      masked = masked.slice(0, from - start) + "x".repeat(to - from) + masked.slice(to - start);
  }
  const found: { start: number; end: number }[] = [];
  for (const match of masked.matchAll(/\*\*(?=\S)[\s\S]*?\S\*\*/g))
    found.push({ start: start + match.index, end: start + match.index + match[0].length });
  return found;
}

/** `[start, end)` of `text` as runs: words, and a chip for each token in it. */
function leaves(
  text: string,
  start: number,
  end: number,
  bold: boolean,
  tokens: readonly ComposerToken[],
): BlockRun[] {
  const runs: BlockRun[] = [];
  let at = start;
  for (const token of tokens) {
    if (token.start < at || token.end > end) continue;
    if (token.start > at) runs.push({ type: "text", text: text.slice(at, token.start), bold });
    runs.push({ type: "chip", text: text.slice(token.start, token.end), bold, token });
    at = token.end;
  }
  if (end > at) runs.push({ type: "text", text: text.slice(at, end), bold });
  return runs;
}

/** The Markdown `text`, with `tokens` as its chips, as the blocks the person sees. */
export function composerBlocks(text: string, tokens: readonly ComposerToken[]): ComposerBlock[] {
  const sorted = tokens.toSorted((a, b) => a.start - b.start);
  let next = 0;
  return composerLines(text).map((line): ComposerBlock => {
    while (next < sorted.length && (sorted[next]?.end ?? 0) <= line.start) next++;
    const own: ComposerToken[] = [];
    for (let at = next; at < sorted.length && (sorted[at]?.start ?? 0) < line.end; at++) {
      const token = sorted[at];
      if (token) own.push(token);
    }
    if (line.kind === "code" || line.kind === "plain")
      return {
        style: { kind: line.kind },
        runs:
          line.kind === "code"
            ? leaves(text, line.start, line.end, false, own)
            : styled(text, line.start, line.end, own),
      };
    const style: BlockStyle =
      line.kind === "heading"
        ? { kind: "heading", level: line.level }
        : { kind: "item", indent: line.indent, marker: line.marker, depth: line.depth };
    return { style, runs: styled(text, line.content, line.end, own) };
  });
}

/** Words with their bold runs, the marks left out. */
function styled(
  text: string,
  start: number,
  end: number,
  tokens: readonly ComposerToken[],
): BlockRun[] {
  const runs: BlockRun[] = [];
  let at = start;
  for (const bold of boldSpans(text, start, end, tokens)) {
    runs.push(...leaves(text, at, bold.start, false, tokens));
    runs.push(...leaves(text, bold.start + 2, bold.end - 2, true, tokens));
    at = bold.end;
  }
  runs.push(...leaves(text, at, end, false, tokens));
  return runs;
}

/** What a block's style is written as, before its words. */
export function blockPrefix(style: BlockStyle): string {
  if (style.kind === "heading") return `${"#".repeat(style.level)} `;
  if (style.kind === "item") return `${" ".repeat(style.indent)}${style.marker} `;
  return "";
}

export interface SerializedBlocks {
  text: string;
  /** Each chip's token at the place it is written now. */
  tokens: ComposerToken[];
  /** `offsets[line][run][k]`: where visible position `k` of that run sits in `text`. */
  offsets: number[][][];
  /** Where each line's words start in `text`, after its prefix. */
  contents: number[];
  /** Where each line starts and ends in `text`. */
  lines: { start: number; end: number }[];
}

const blank = (run: BlockRun) => run.type === "text" && !run.text.trim();

/**
 * The blocks as Markdown. Neighbouring bold runs share one pair of `**`; spaces at the edges of
 * bold words go outside the marks (Markdown bold can't start or end with a space), and bold
 * that is only spaces is written plain.
 */
export function serializeBlocks(blocks: readonly ComposerBlock[]): SerializedBlocks {
  let text = "";
  const tokens: ComposerToken[] = [];
  const offsets: number[][][] = [];
  const contents: number[] = [];
  const lines: { start: number; end: number }[] = [];
  blocks.forEach((block, line) => {
    if (line > 0) text += "\n";
    const start = text.length;
    text += blockPrefix(block.style);
    contents.push(text.length);
    const runOffsets: number[][] = block.runs.map(() => []);
    const code = block.style.kind === "code";
    let index = 0;
    while (index < block.runs.length) {
      const first = block.runs[index];
      if (!first) break;
      const bold = !code && first.bold;
      // Fenced code is one plain group; elsewhere a group is the runs of one weight.
      let end = code ? block.runs.length : index + 1;
      while (end < block.runs.length && block.runs[end]?.bold === bold) end++;
      // Each unit of the group: a character of a text run, or a chip.
      const units: { run: number; k: number; text: string; chip: boolean }[] = [];
      for (let run = index; run < end; run++) {
        const each = block.runs[run];
        if (!each) continue;
        if (each.type === "chip") units.push({ run, k: 0, text: each.text, chip: true });
        else
          for (let k = 0; k < each.text.length; k++)
            units.push({ run, k, text: each.text[k] ?? "", chip: false });
      }
      const visible = units.map((unit) => unit.chip || !!unit.text.trim());
      const firstWord = bold ? visible.indexOf(true) : -1;
      const lastWord = bold ? visible.lastIndexOf(true) : -1;
      units.forEach((unit, at) => {
        if (at === firstWord) text += "**";
        const into = runOffsets[unit.run];
        into?.push(text.length);
        const run = block.runs[unit.run];
        if (unit.chip && run?.type === "chip" && run.token)
          tokens.push({ ...run.token, start: text.length, end: text.length + unit.text.length });
        text += unit.text;
        const last = at === units.length - 1 || units[at + 1]?.run !== unit.run;
        // The run's end sits right after its last unit, inside any closing marks.
        if (last) into?.push(text.length);
        if (at === lastWord) text += "**";
      });
      for (let run = index; run < end; run++)
        if (!runOffsets[run]?.length) runOffsets[run] = [text.length];
      index = end;
    }
    offsets.push(runOffsets);
    lines.push({ start, end: text.length });
  });
  return { text, tokens, offsets, contents, lines };
}

/** Where `point` sits in the Markdown `serialized` writes. */
export function pointOffset(serialized: SerializedBlocks, point: BlockPoint): number {
  const runs = serialized.offsets[point.line];
  if (!runs) return serialized.text.length;
  if (!runs.length) return serialized.contents[point.line] ?? serialized.text.length;
  const run = runs[Math.min(point.run, runs.length - 1)] ?? [];
  if (point.run >= runs.length) return run.at(-1) ?? serialized.text.length;
  return run[Math.min(point.offset, run.length - 1)] ?? serialized.text.length;
}

/**
 * The visible position for Markdown offset `offset`. An offset in hidden syntax goes to the
 * nearest visible place: past a line's prefix and opening marks to the words, and before closing
 * marks to the end of the bold words, so what is typed there carries the bold on.
 */
export function offsetPoint(
  blocks: readonly ComposerBlock[],
  serialized: SerializedBlocks,
  offset: number,
): BlockPoint {
  const found = serialized.lines.findIndex((each) => offset <= each.end);
  const line = found === -1 ? Math.max(0, serialized.lines.length - 1) : found;
  let before: BlockPoint | undefined;
  for (const [run, positions] of (serialized.offsets[line] ?? []).entries())
    for (const [k, at] of positions.entries()) {
      const point = { line, run, offset: k };
      const runs = blocks[line]?.runs ?? [];
      // Right after bold words, typing carries them on: the end of the bold words, not the
      // start of the plain ones after their closing marks.
      if (at === offset && k === 0 && before && runs[before.run]?.bold && !runs[run]?.bold)
        return before;
      if (at === offset) return point;
      if (at < offset) {
        before = point;
        continue;
      }
      // In hidden marks: back to the bold words they close, or on to the words they open.
      return before && blocks[line]?.runs[before.run]?.bold ? before : point;
    }
  return before ?? { line, run: 0, offset: 0 };
}

/** A block as a comparable value: its style and its runs, neighbours of one kind joined. */
export function blockSignature(blocks: readonly ComposerBlock[]): string {
  return JSON.stringify(
    blocks.map((block) => {
      const runs: (string | boolean)[][] = [];
      for (const run of block.runs) {
        if (run.type === "text" && !run.text) continue;
        const last = runs.at(-1);
        if (run.type === "text" && last?.[0] === "t" && last[2] === run.bold) {
          last[1] = `${String(last[1])}${run.text}`;
          continue;
        }
        runs.push([run.type === "text" ? "t" : "c", run.text, run.bold]);
      }
      const style = block.style;
      const key =
        style.kind === "item"
          ? `item:${style.indent}:${style.marker}:${style.depth}`
          : style.kind === "heading"
            ? `h${style.level}`
            : style.kind;
      return [key, runs];
    }),
  );
}

/** Whether a block shows nothing: no words and no chips. */
export function emptyBlock(block: ComposerBlock): boolean {
  return block.runs.every(blank) && !block.runs.some((run) => run.type === "chip");
}
