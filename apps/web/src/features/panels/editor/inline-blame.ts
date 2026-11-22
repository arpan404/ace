import type { GitBlameCommit } from "@ace/protocol";
import type { ChangeHunk } from "@ace/ui-core";
import { formatRelativeWords } from "@/lib/git-history.ts";
import type { AgentBlock } from "./agent-lines.ts";

/** Chunk size for `git.blame` requests (well under the 500-line daemon cap). */
export const blameChunkSize = 120;

export interface BlameRangeChunk {
  /** 0-based chunk index. */
  index: number;
  /** 1-based inclusive start line. */
  startLine: number;
  /** 1-based inclusive end line. */
  endLine: number;
}

export type BlameAttribution =
  | {
      kind: "agent";
      name: string;
      label: string;
      at: number;
      turn?: number | undefined;
    }
  | {
      kind: "uncommitted";
      label: string;
    }
  | {
      kind: "commit";
      label: string;
      age: string;
      commit: GitBlameCommit;
    };

/**
 * The committed line (at the blamed commit) the editor's 1-based `line` still is, through the
 * gutter's hunks against that commit: null for a line inside an added or changed block (not
 * committed), the line shifted by every block above it otherwise.
 */
export function committedLineAt(hunks: readonly ChangeHunk[], line: number): number | null {
  let shift = 0;
  for (const hunk of hunks) {
    if (line < hunk.start) break;
    if (line < hunk.start + hunk.added.length) return null;
    shift += hunk.removed.length - hunk.added.length;
  }
  return line + shift;
}

/** The committed lines behind the editor's visible `first..last`; undefined when none are. */
export function committedRange(
  hunks: readonly ChangeHunk[],
  first: number,
  last: number,
): { first: number; last: number } | undefined {
  let low: number | undefined;
  let high: number | undefined;
  for (let line = first; line <= last; line++) {
    const committed = committedLineAt(hunks, line);
    if (committed === null) continue;
    low ??= committed;
    high = committed;
  }
  return low === undefined || high === undefined ? undefined : { first: low, last: high };
}

/**
 * The whole fixed chunks (`chunkSize` lines, 1-based inclusive) covering committed lines
 * `firstLine..lastLine` not fetched yet. A chunk is always asked for whole: the blamed commit's
 * file never changes, so a chunk once fetched is complete (git stops at the file's end).
 */
export function missingBlameChunks(
  fetchedChunks: ReadonlySet<number>,
  firstLine: number,
  lastLine: number,
  chunkSize = blameChunkSize,
): BlameRangeChunk[] {
  if (lastLine < firstLine || lastLine < 1) return [];
  const startChunk = Math.floor((Math.max(1, firstLine) - 1) / chunkSize);
  const endChunk = Math.floor((lastLine - 1) / chunkSize);
  const missing: BlameRangeChunk[] = [];
  for (let index = startChunk; index <= endChunk; index++) {
    if (fetchedChunks.has(index)) continue;
    missing.push({ index, startLine: index * chunkSize + 1, endLine: (index + 1) * chunkSize });
  }
  return missing;
}

/**
 * Resolves the end-of-line blame annotation for 1-based `caretLine`.
 * Precedence:
 * 1. Lines an agent wrote in this thread say the agent's name.
 * 2. Lines not in the blamed commit (`committedLine` null: added or changed since, saved or
 *    not) or with no history there (`lineSha` null) say "You · not committed yet".
 * 3. Committed lines say "Author, 3 days ago · subject" and carry the commit for hover.
 * `committedLine` undefined means the edit-to-commit mapping is out of date: nothing is said.
 */
export function resolveCaretBlame(input: {
  caretLine: number;
  agentBlocks: readonly AgentBlock[];
  committedLine: number | null | undefined;
  lineSha: string | null | undefined;
  commits: ReadonlyMap<string, GitBlameCommit>;
  now: number;
}): BlameAttribution | undefined {
  const { caretLine, agentBlocks, committedLine, lineSha, commits, now } = input;
  if (caretLine < 1) return undefined;

  // 1. Agent-authored lines (0-based half-open [start, end)).
  const zeroLine = caretLine - 1;
  for (const block of agentBlocks) {
    if (zeroLine >= block.start && zeroLine < block.end) {
      const age = formatRelativeWords(block.at, now);
      const turn = block.who.turn === undefined ? "" : ` · turn ${block.who.turn}`;
      return {
        kind: "agent",
        name: block.who.name,
        label: `${block.who.name}, ${age}${turn}`,
        at: block.at,
        turn: block.who.turn,
      };
    }
  }

  if (committedLine === undefined) return undefined;
  // 2. Not in the blamed commit.
  if (committedLine === null || lineSha === null) {
    return { kind: "uncommitted", label: "You · not committed yet" };
  }

  // 3. Committed line from the cached blame.
  if (lineSha === undefined) return undefined;
  const commit = commits.get(lineSha);
  if (!commit) return undefined;
  const age = formatRelativeWords(commit.authoredAt, now);
  const subject = commit.subject ? ` · ${commit.subject}` : "";
  return {
    kind: "commit",
    label: `${commit.authorName}, ${age}${subject}`,
    age,
    commit,
  };
}
