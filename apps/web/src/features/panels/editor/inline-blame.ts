import type { GitBlameCommit } from "@ace/protocol";
import type { LineMark } from "@ace/ui-core";
import { formatRelativeWords } from "@/lib/git-history.ts";
import type { AgentBlock } from "./agent-lines.ts";

/** Chunk size for visible-range `git.blame` requests (well under the 500-line daemon cap). */
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
 * Returns quantized `[startLine, endLine]` chunks covering the visible 1-based range that have
 * not yet been fetched for this file/HEAD.
 */
export function missingBlameChunks(
  fetchedChunks: ReadonlySet<number>,
  firstLine: number,
  lastLine: number,
  lineCount: number,
  chunkSize = blameChunkSize,
): BlameRangeChunk[] {
  if (lineCount <= 0 || lastLine < firstLine) return [];
  const clampedStart = Math.max(1, Math.min(lineCount, firstLine));
  const clampedEnd = Math.max(clampedStart, Math.min(lineCount, lastLine));
  const startChunk = Math.floor((clampedStart - 1) / chunkSize);
  const endChunk = Math.floor((clampedEnd - 1) / chunkSize);
  const missing: BlameRangeChunk[] = [];
  for (let index = startChunk; index <= endChunk; index++) {
    if (fetchedChunks.has(index)) continue;
    const startLine = index * chunkSize + 1;
    const endLine = Math.min(lineCount, (index + 1) * chunkSize);
    missing.push({ index, startLine, endLine });
  }
  return missing;
}

/**
 * Resolves the end-of-line blame annotation for 1-based `caretLine`.
 * Precedence:
 * 1. Lines an agent wrote in this thread say the agent's name.
 * 2. Local uncommitted additions/modifications or git blame's null SHA say "You · not committed yet".
 * 3. Committed lines say "Author, 3 days ago · subject" and carry full commit details for hover.
 */
export function resolveCaretBlame(input: {
  caretLine: number;
  agentBlocks: readonly AgentBlock[];
  marks?: ReadonlyMap<number, LineMark> | undefined;
  lineSha: string | null | undefined;
  commits: ReadonlyMap<string, GitBlameCommit>;
  now: number;
}): BlameAttribution | undefined {
  const { caretLine, agentBlocks, marks, lineSha, commits, now } = input;
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

  // 2. Uncommitted lines (live editor diff marks or git blame null SHA).
  const mark = marks?.get(caretLine);
  if (mark === "added" || mark === "modified" || lineSha === null) {
    return { kind: "uncommitted", label: "You · not committed yet" };
  }

  // 3. Committed line from cached visible-range blame.
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
