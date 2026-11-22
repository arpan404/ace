import type { GitBlameCommit } from "@ace/protocol";
import type { LineMark } from "@ace/ui-core";
import { describe, expect, test } from "vitest";
import { missingBlameChunks, resolveCaretBlame } from "./inline-blame.ts";

const now = 1_700_000_000_000;
const sha = "a".repeat(40);
const commit: GitBlameCommit = {
  sha,
  shortSha: sha.slice(0, 7),
  subject: "Add outline extractor",
  authorName: "Arpan",
  authorEmail: "arpan@example.invalid",
  authoredAt: now - 3 * 86_400_000,
};
const commits = new Map([[sha, commit]]);

describe("missingBlameChunks", () => {
  test("quantizes visible ranges into bounded chunks and skips already-fetched chunks", () => {
    expect(missingBlameChunks(new Set(), 1, 40, 350, 120)).toEqual([
      { index: 0, startLine: 1, endLine: 120 },
    ]);

    expect(missingBlameChunks(new Set([0]), 100, 260, 350, 120)).toEqual([
      { index: 1, startLine: 121, endLine: 240 },
      { index: 2, startLine: 241, endLine: 350 },
    ]);

    expect(missingBlameChunks(new Set([0, 1, 2]), 1, 350, 350, 120)).toEqual([]);
  });
});

describe("resolveCaretBlame", () => {
  test("prioritizes agent-authored lines over uncommitted and committed blame", () => {
    const result = resolveCaretBlame({
      caretLine: 5,
      agentBlocks: [
        {
          start: 4,
          end: 7,
          who: { name: "Claude Code", turn: 2 },
          at: now - 120_000,
        },
      ],
      marks: new Map<number, LineMark>([[5, "added"]]),
      lineSha: sha,
      commits,
      now,
    });
    expect(result).toMatchObject({
      kind: "agent",
      name: "Claude Code",
      label: "Claude Code, 2 minutes ago · turn 2",
    });
  });

  test("marks local uncommitted edits and null blame SHAs as not committed yet", () => {
    expect(
      resolveCaretBlame({
        caretLine: 2,
        agentBlocks: [],
        marks: new Map<number, LineMark>([[2, "modified"]]),
        lineSha: sha,
        commits,
        now,
      }),
    ).toEqual({ kind: "uncommitted", label: "You · not committed yet" });

    expect(
      resolveCaretBlame({
        caretLine: 3,
        agentBlocks: [],
        marks: new Map(),
        lineSha: null,
        commits,
        now,
      }),
    ).toEqual({ kind: "uncommitted", label: "You · not committed yet" });
  });

  test("formats committed line attribution as Author, relative time · subject", () => {
    const result = resolveCaretBlame({
      caretLine: 1,
      agentBlocks: [],
      marks: new Map(),
      lineSha: sha,
      commits,
      now,
    });
    expect(result).toMatchObject({
      kind: "commit",
      label: "Arpan, 3 days ago · Add outline extractor",
      commit,
    });
  });
});
