import type { GitBlameCommit } from "@ace/protocol";
import { hunksFromChanges } from "@ace/ui-core";
import { describe, expect, test } from "vitest";
import {
  committedLineAt,
  committedRange,
  missingBlameChunks,
  resolveCaretBlame,
} from "./inline-blame.ts";

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

/**
 * The gutter's hunks for the editor's `lines`: each change's `start..end` are the editor's lines,
 * its `text` the committed lines they replaced (as the live gutter computes them).
 */
function hunks(lines: readonly string[], changes: Parameters<typeof hunksFromChanges>[0]) {
  return hunksFromChanges(changes, (line) => lines[line] ?? "", lines.length);
}

describe("committedLineAt", () => {
  test("a line below an unsaved deletion maps to the committed line it still is", () => {
    // Committed: a, b, c. The editor deleted line 1 without saving: b, c.
    const deleted = hunks(["b", "c"], [{ start: 0, end: 0, text: "a\n" }]);
    expect(committedLineAt(deleted, 1)).toBe(2);
    expect(committedLineAt(deleted, 2)).toBe(3);
  });

  test("lines inside an added or changed block are not committed; lines past it shift", () => {
    // Committed: a, b, c. The editor has a, NEW1, NEW2, b, c.
    const added = hunks(["a", "x", "y", "b", "c"], [{ start: 1, end: 3, text: "" }]);
    expect(committedLineAt(added, 1)).toBe(1);
    expect(committedLineAt(added, 2)).toBeNull();
    expect(committedLineAt(added, 3)).toBeNull();
    expect(committedLineAt(added, 4)).toBe(2);
    expect(committedLineAt(added, 5)).toBe(3);
  });

  test("with no changes every line is its committed line", () => {
    expect(committedLineAt([], 7)).toBe(7);
  });
});

describe("committedRange", () => {
  test("covers the committed lines behind the visible lines, skipping uncommitted ones", () => {
    const added = hunks(["x", "a", "b", "c"], [{ start: 0, end: 1, text: "" }]);
    expect(committedRange(added, 1, 4)).toEqual({ first: 1, last: 3 });
    expect(committedRange(added, 1, 1)).toBeUndefined();
  });
});

describe("missingBlameChunks", () => {
  test("asks for whole fixed chunks, never a tail cut at today's line count", () => {
    expect(missingBlameChunks(new Set(), 1, 40, 120)).toEqual([
      { index: 0, startLine: 1, endLine: 120 },
    ]);
    expect(missingBlameChunks(new Set([0]), 100, 260, 120)).toEqual([
      { index: 1, startLine: 121, endLine: 240 },
      { index: 2, startLine: 241, endLine: 360 },
    ]);
    expect(missingBlameChunks(new Set([0, 1, 2]), 1, 350, 120)).toEqual([]);
  });
});

describe("resolveCaretBlame", () => {
  test("prioritizes agent-authored lines over uncommitted and committed blame", () => {
    const result = resolveCaretBlame({
      caretLine: 5,
      agentBlocks: [{ start: 4, end: 7, who: { name: "Claude Code", turn: 2 }, at: now - 120_000 }],
      committedLine: null,
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

  test("an edited line, or one git has no history for, is not committed yet", () => {
    expect(
      resolveCaretBlame({
        caretLine: 2,
        agentBlocks: [],
        committedLine: null,
        lineSha: sha,
        commits,
        now,
      }),
    ).toEqual({ kind: "uncommitted", label: "You · not committed yet" });
    expect(
      resolveCaretBlame({
        caretLine: 3,
        agentBlocks: [],
        committedLine: 3,
        lineSha: null,
        commits,
        now,
      }),
    ).toEqual({ kind: "uncommitted", label: "You · not committed yet" });
  });

  test("says nothing while the edit-to-commit mapping is out of date", () => {
    expect(
      resolveCaretBlame({
        caretLine: 1,
        agentBlocks: [],
        committedLine: undefined,
        lineSha: sha,
        commits,
        now,
      }),
    ).toBeUndefined();
  });

  test("formats committed line attribution as Author, relative time · subject", () => {
    const result = resolveCaretBlame({
      caretLine: 1,
      agentBlocks: [],
      committedLine: 1,
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
