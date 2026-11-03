import { describe, expect, it } from "vitest";
import type { ForgeReviewDraft } from "@ace/protocol/forge-review";
import {
  draftsToMove,
  fileCommentBody,
  moveDraft,
  movedDraft,
  type Comparison,
} from "./review-draft-move.ts";

const old = "a".repeat(40);
const head = "b".repeat(40);
const draft = (
  line: number,
  extra: Partial<ForgeReviewDraft["anchor"]> = {},
): ForgeReviewDraft => ({
  id: `d${line}`,
  body: "Rename this",
  anchor: { commit: old, path: "src/a.ts", line, side: "RIGHT", ...extra },
});
const compare = (files: Comparison["files"], more: Partial<Comparison> = {}): Comparison => ({
  descends: true,
  merges: false,
  complete: true,
  files,
  ...more,
});
// The PR's patch at the new head: lines 1-30 of the new file all drawn as context.
const hosted = (path = "src/a.ts", lines = 30) => [
  {
    path,
    patch: `@@ -1,${lines} +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => ` l${i + 1}`).join("\n")}`,
  },
];

describe("a draft after a push", () => {
  it("stays on the same lines when the push didn't touch its file", () => {
    const move = moveDraft(draft(12), head, compare([]), hosted());
    expect(move).toEqual({
      kind: "moved",
      anchor: { commit: head, path: "src/a.ts", line: 12, side: "RIGHT" },
    });
  });

  it("follows its line down when lines were added above it", () => {
    const patch = "@@ -2,2 +2,4 @@\n l2\n+new1\n+new2\n l3";
    const move = moveDraft(
      draft(12),
      head,
      compare([{ path: "src/a.ts", status: "modified", patch }]),
      hosted(),
    );
    expect(move).toMatchObject({ kind: "moved", anchor: { line: 14 } });
  });

  it("follows a multi-line range up when a line above it was removed", () => {
    const patch = "@@ -1,3 +1,2 @@\n l1\n-l2\n l3";
    const move = moveDraft(
      draft(12, { startLine: 10 }),
      head,
      compare([{ path: "src/a.ts", status: "modified", patch }]),
      hosted(),
    );
    expect(move).toMatchObject({ kind: "moved", anchor: { startLine: 9, line: 11 } });
  });

  it("is outdated, keeping the code it was written on, when its line was changed", () => {
    const patch = "@@ -11,3 +11,3 @@\n l11\n-const total = 1;\n+const total = 2;\n l13";
    const written = draft(12);
    const move = moveDraft(
      written,
      head,
      compare([{ path: "src/a.ts", status: "modified", patch }]),
      hosted(),
    );
    expect(move).toEqual({ kind: "outdated", code: ["l11", "const total = 1;"] });
    const kept = movedDraft(written, move, head);
    // Never lost: same text, same place, now marked.
    expect(kept.body).toBe("Rename this");
    expect(kept.anchor).toEqual(written.anchor);
    expect(kept.outdated).toEqual({ headSha: head, code: ["l11", "const total = 1;"] });
  });

  it("is outdated when a line was added inside its range", () => {
    const patch = "@@ -10,2 +10,3 @@\n l10\n+inserted\n l11";
    const move = moveDraft(
      draft(12, { startLine: 10 }),
      head,
      compare([{ path: "src/a.ts", status: "modified", patch }]),
      hosted(),
    );
    expect(move.kind).toBe("outdated");
  });

  it("follows its file through a rename", () => {
    const move = moveDraft(
      draft(5),
      head,
      compare([{ path: "src/b.ts", previousPath: "src/a.ts", status: "renamed" }]),
      hosted("src/b.ts"),
    );
    expect(move).toMatchObject({ kind: "moved", anchor: { path: "src/b.ts", line: 5 } });
  });

  it("is outdated when its file was deleted, changed without a patch, or force-pushed over", () => {
    const deleted = compare([{ path: "src/a.ts", status: "removed" }]);
    const binary = compare([{ path: "src/a.ts", status: "modified" }]);
    const rewritten = compare([], { descends: false });
    const unlisted = compare([], { complete: false });
    for (const c of [deleted, binary, rewritten, unlisted])
      expect(moveDraft(draft(5), head, c, hosted()).kind).toBe("outdated");
  });

  it("is outdated when its unchanged line is no longer in the pull request's diff", () => {
    expect(moveDraft(draft(40), head, compare([]), hosted()).kind).toBe("outdated");
  });

  it("on the old side stays unless a merge could have moved the base", () => {
    const left = draft(3, { side: "LEFT" });
    expect(moveDraft(left, head, compare([]), hosted()).kind).toBe("moved");
    expect(moveDraft(left, head, compare([], { merges: true }), hosted())).toEqual({
      kind: "outdated",
      code: ["l1", "l2", "l3"],
    });
  });

  it("takes its code from the old file when no patch shows the lines", () => {
    const file = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const move = moveDraft(draft(40, { startLine: 39 }), head, compare([]), hosted(), file);
    expect(move).toEqual({
      kind: "outdated",
      code: ["line 36", "line 37", "line 38", "line 39", "line 40"],
    });
  });

  it("is tried again at a newer head, and not again at the same one", () => {
    const tried = movedDraft(draft(12), { kind: "outdated", code: ["x"] }, head);
    expect(draftsToMove([tried, draft(3)], head).map((d) => d.id)).toEqual(["d3"]);
    expect(draftsToMove([tried], "c".repeat(40))).toHaveLength(1);
    // A later try that finds no code keeps the code found before.
    expect(
      movedDraft(tried, { kind: "outdated", code: [] }, "c".repeat(40)).outdated?.code,
    ).toEqual(["x"]);
  });
});

describe("an outdated draft posted on its file", () => {
  it("says where it was and quotes its code in a fence its backticks can't close", () => {
    const body = fileCommentBody({
      ...draft(12),
      outdated: { headSha: head, code: ["const a = ```;"] },
    });
    expect(body).toBe(
      `On line 12 at aaaaaaa:\n\n\`\`\`\`\nconst a = \`\`\`;\n\`\`\`\`\n\nRename this`,
    );
  });
});
