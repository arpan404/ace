import type { ProviderKind } from "@ace/protocol";
import { linesOf, type WholeLineChange } from "@ace/ui-core";

/*
 * Lines an agent wrote in an open file (docs/editor/workbench.md 43): blocks of 0-based lines,
 * moved through every later change by the whole-line changes between two texts. A block the
 * person edits stops being the agent's (its lines keep their ordinary change mark). Pure and
 * linear in the blocks and changes, never in the file.
 */

/** Who wrote a block, as its hover names them. */
export interface AgentWho {
  /** "Claude Code", or another thread's title. */
  name: string;
  provider?: ProviderKind | undefined;
  /** This thread's turn that made the change (1-based), when known. */
  turn?: number | undefined;
}

/** Lines `start..end` (0-based, `end` exclusive) an agent wrote; empty where it only removed. */
export interface AgentBlock {
  start: number;
  end: number;
  who: AgentWho;
  /** When the change landed, in ms. */
  at: number;
}

/** Whether `change` (old lines `start..end`) reaches into `block`'s lines. */
function touches(block: AgentBlock, change: WholeLineChange): boolean {
  if (block.start === block.end)
    // Where lines were only removed: the lines on either side of the gap changed again.
    return change.start <= block.start && change.end >= block.start && change.end > change.start;
  if (change.start === change.end) return change.start > block.start && change.start < block.end;
  return change.start < block.end && change.end > block.start;
}

/**
 * `blocks` in the new text's lines after `changes` (in the old text's lines, in order); a block
 * a change reaches into is dropped.
 */
export function mapBlocks(
  blocks: readonly AgentBlock[],
  changes: readonly WholeLineChange[],
): AgentBlock[] {
  if (changes.length === 0 || blocks.length === 0) return [...blocks];
  const out: AgentBlock[] = [];
  for (const block of blocks) {
    let delta = 0;
    let dropped = false;
    for (const change of changes) {
      if (touches(block, change)) {
        dropped = true;
        break;
      }
      const before =
        change.end <= block.start && (change.end > change.start || change.start <= block.start);
      if (!before) break;
      delta += linesOf(change.text).length - (change.end - change.start);
    }
    if (!dropped) out.push({ ...block, start: block.start + delta, end: block.end + delta });
  }
  return out;
}

/**
 * The agent's own `changes` landed: earlier blocks move (or go, where it wrote over them) and each
 * change becomes a block of the lines it wrote.
 */
export function landBlocks(
  blocks: readonly AgentBlock[],
  changes: readonly WholeLineChange[],
  who: AgentWho,
  at: number,
): AgentBlock[] {
  const kept = mapBlocks(blocks, changes);
  let delta = 0;
  for (const change of changes) {
    const start = change.start + delta;
    const written = linesOf(change.text).length;
    kept.push({ start, end: start + written, who, at });
    delta += written - (change.end - change.start);
  }
  return kept.toSorted((a, b) => a.start - b.start || a.end - b.end);
}

/** The block a 0-based line belongs to (a removal's block sits on the line below the gap). */
export function blockAt(blocks: readonly AgentBlock[], line: number): AgentBlock | undefined {
  return blocks.find((block) =>
    block.start === block.end ? block.start === line : line >= block.start && line < block.end,
  );
}

/** A block's hover: "Claude Code changed this in turn 2". */
export function blockWords(who: AgentWho): string {
  return who.turn === undefined
    ? `${who.name} changed this`
    : `${who.name} changed this in turn ${who.turn}`;
}

/** Drop the blocks overlapping 0-based lines `start..end` (the person kept or reverted them). */
export function withoutLines(
  blocks: readonly AgentBlock[],
  start: number,
  end: number,
): AgentBlock[] {
  return blocks.filter((block) =>
    block.start === block.end
      ? block.start < start || block.start > end
      : block.end <= start || block.start >= Math.max(end, start + 1),
  );
}
