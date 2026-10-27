import { describe, expect, it } from "vitest";
import type { GitConflictSegment } from "@ace/protocol";
import { conflictHunks, conflictRefusalText, resolveHunk } from "./pr-conflicts-model.ts";

const hunk = (ours: string, theirs: string): GitConflictSegment => ({
  kind: "conflict",
  ours,
  base: null,
  theirs,
  markers: { ours: "<<<<<<< HEAD\n", base: null, separator: "=======\n", theirs: ">>>>>>> main\n" },
});
const file: GitConflictSegment[] = [
  { kind: "text", text: "top\n" },
  hunk("a\n", "b\n"),
  { kind: "text", text: "middle\n" },
  hunk("c\n", "d\n"),
];

describe("resolving one conflict hunk", () => {
  it("keeps both sides, ours first, and leaves the other hunk to resolve", () => {
    const text = resolveHunk(file, 0, { kind: "both" });
    expect(text).toBe("top\na\nb\nmiddle\n<<<<<<< HEAD\nc\n=======\nd\n>>>>>>> main\n");
  });

  it("takes one side's lines or the person's own text", () => {
    expect(resolveHunk(file, 1, { kind: "theirs" })).toMatch(/middle\nd\n$/);
    expect(resolveHunk(file, 1, { kind: "edit", text: "mine\n" })).toMatch(/middle\nmine\n$/);
  });

  it("tells hunks apart by where they start in the file", () => {
    expect(conflictHunks(file).map((each) => each.start)).toEqual([4, 49]);
  });
});

describe("a refused conflict step", () => {
  it("says the head branch moved when a push is rejected", () => {
    expect(conflictRefusalText("git_push_rejected", "fix/x")).toMatch(/^fix\/x moved on GitHub/);
  });
});
