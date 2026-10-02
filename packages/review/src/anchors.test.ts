import { describe, expect, it } from "vitest";
import type { DiffResult } from "@ace/git";
import { ReviewAnchor } from "@ace/protocol";
import { anchorComment, reanchorComments } from "./index.ts";

const revision = { kind: "commit", ref: "next" } as const;
const anchor = ReviewAnchor.parse({
  position: { file: "file.ts", side: "new", start: 4, end: 4 },
  revision: { kind: "commit", ref: "base" },
  state: "active",
  fingerprint: { before: ["before"], lines: ["const value = wrong;"], after: ["after"] },
});
function patch(body: string, path = "file.ts", oldPath = path): DiffResult {
  return {
    entries: [
      {
        path,
        ...(oldPath === path ? {} : { oldPath }),
        status: "M",
        additions: 1,
        deletions: 1,
        binary: false,
      },
    ],
    patch: `diff --git a/${oldPath} b/${path}\n--- a/${oldPath}\n+++ b/${path}\n${body}\n`,
    truncated: false,
  };
}
const run = (diff: DiffResult, input = anchor) => reanchorComments([input], diff, revision)[0];

describe("comment anchors", () => {
  it("follows an insertion above a comment", () => {
    expect(run(patch("@@ -1,1 +1,2 @@\n+inserted\n first"))?.position.start).toBe(5);
  });
  it("follows a deletion above a comment", () => {
    expect(run(patch("@@ -1,2 +1,1 @@\n-removed\n first"))?.position.start).toBe(3);
  });
  it("follows a move above a comment without marking it addressed", () => {
    const result = run(patch("@@ -1,2 +1,1 @@\n-moved\n first\n@@ -6,1 +5,2 @@\n last\n+moved"));
    expect(result?.position.start).toBe(3);
    expect(result?.state).toBe("active");
  });
  it("keeps the last position when selected lines disappear", () => {
    const result = run(patch("@@ -3,3 +3,2 @@\n before\n-const value = wrong;\n after"));
    expect(result?.state).toBe("outdated");
    expect(result?.position).toEqual(anchor.position);
    expect(result?.revision).toEqual(anchor.revision);
  });
  it("matches small edits using surviving context and asks for review", () => {
    const result = run(
      patch("@@ -3,3 +3,3 @@\n before\n-const value = wrong;\n+const value = right;\n after"),
    );
    expect(result?.position.start).toBe(4);
    expect(result?.fingerprint.lines).toEqual(["const value = right;"]);
    expect(result?.state).toBe("addressed-pending-review");
  });
  it("follows unique selected text moved to another hunk", () => {
    const result = run(
      patch(
        "@@ -3,3 +3,2 @@\n before\n-const value = wrong;\n after\n@@ -9,1 +8,2 @@\n last\n+const value = wrong;",
      ),
    );
    expect(result?.position.start).toBe(9);
    expect(result?.state).toBe("addressed-pending-review");
  });
  it("does not guess between identical destinations", () => {
    expect(
      run(
        patch(
          "@@ -3,3 +3,2 @@\n before\n-const value = wrong;\n after\n@@ -9,1 +8,3 @@\n last\n+const value = wrong;\n+const value = wrong;",
        ),
      )?.state,
    ).toBe("outdated");
  });
  it("follows a file rename", () => {
    expect(
      run(patch("@@ -1,1 +1,2 @@\n+inserted\n first", "renamed.ts", "file.ts"))?.position.file,
    ).toBe("renamed.ts");
  });
  it("can map old-side findings through their own revision transition", () => {
    const old = { ...anchor, position: { ...anchor.position, side: "old" as const } };
    const result = run(patch("@@ -1,1 +1,2 @@\n+inserted\n first"), old);
    expect(result?.position).toEqual({ ...old.position, start: 5, end: 5 });
  });
  it("expands a selected range after an insertion inside it", () => {
    const range = {
      ...anchor,
      position: { ...anchor.position, start: 3, end: 5 },
      fingerprint: { before: [], lines: ["before", "const value = wrong;", "after"], after: [] },
    };
    const result = run(
      patch("@@ -3,3 +3,4 @@\n before\n+inside\n const value = wrong;\n after"),
      range,
    );
    expect(result?.position).toEqual({ ...range.position, end: 6 });
    expect(result?.state).toBe("addressed-pending-review");
  });
  it("refuses truncated transitions instead of losing anchors", () => {
    expect(() => run({ ...patch(""), truncated: true })).toThrow("review_diff_too_large");
  });
  it("rejects a line range absent from the displayed diff", () => {
    expect(() =>
      anchorComment(patch("@@ -1 +1 @@\n-first\n+second"), anchor.position, revision),
    ).toThrow("review_lines_not_visible");
  });
  it("captures hunk context without diff marker text", () => {
    const result = anchorComment(
      patch("@@ -3,3 +3,3 @@\n before\n-const value = wrong;\n+const value = right;\n after"),
      anchor.position,
      revision,
    );
    expect(result.fingerprint).toEqual({
      before: ["before"],
      lines: ["const value = right;"],
      after: ["after"],
    });
  });
});

it("follows a rename even when Git emits no content hunks", () => {
  const diff: DiffResult = {
    entries: [
      {
        path: "renamed.ts",
        oldPath: "file.ts",
        status: "R",
        additions: 0,
        deletions: 0,
        binary: false,
      },
    ],
    patch:
      "diff --git a/file.ts b/renamed.ts\nsimilarity index 100%\nrename from file.ts\nrename to renamed.ts\n",
    truncated: false,
  };
  expect(run(diff)?.position.file).toBe("renamed.ts");
});
it("marks text findings outdated when the file becomes binary", () => {
  const diff: DiffResult = {
    entries: [{ path: "file.ts", status: "M", additions: 0, deletions: 0, binary: true }],
    patch: "Binary files a/file.ts and b/file.ts differ\n",
    truncated: false,
  };
  expect(run(diff)?.state).toBe("outdated");
});
