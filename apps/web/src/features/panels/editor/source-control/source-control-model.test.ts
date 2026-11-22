import { describe, expect, test } from "vitest";
import {
  buildSections,
  canCommitChanges,
  emptySelection,
  pruneSelection,
  selectRow,
  splitPath,
  targetPaths,
} from "./source-control-model.ts";

describe("source-control-model", () => {
  test("buildSections groups conflicts, staged, and combined unstaged/untracked with unique totalCount", () => {
    const sections = buildSections({
      kind: "gitStatus",
      files: [],
      truncated: false,
      conflicted: [{ path: "src/merge.ts", status: "conflicted", fingerprint: "f" }],
      staged: [
        { path: "src/app.ts", status: "modified", fingerprint: "f" },
        { path: "src/renamed.ts", from: "src/old.ts", status: "renamed", fingerprint: "f" },
      ],
      unstaged: [
        { path: "src/app.ts", status: "modified", fingerprint: "f" },
        { path: "src/removed.ts", status: "deleted", fingerprint: "f" },
      ],
      untracked: [{ path: "src/brand-new.ts", status: "untracked", fingerprint: "f" }],
    });

    expect(sections.conflicts.map((item) => [item.path, item.letter])).toEqual([
      ["src/merge.ts", "C"],
    ]);
    expect(sections.staged.map((item) => [item.path, item.letter, item.oldPath])).toEqual([
      ["src/app.ts", "M", undefined],
      ["src/renamed.ts", "R", "src/old.ts"],
    ]);
    expect(sections.changes.map((item) => [item.path, item.letter, item.untracked])).toEqual([
      ["src/app.ts", "M", false],
      ["src/brand-new.ts", "U", true],
      ["src/removed.ts", "D", false],
    ]);
    // src/app.ts appears in both staged and unstaged, so total unique files is 5.
    expect(sections.totalCount).toBe(5);
  });

  test("splitPath separates base file name and folder", () => {
    expect(splitPath("README.md")).toEqual({ name: "README.md", folder: "" });
    expect(splitPath("apps/web/src/app.tsx")).toEqual({
      name: "app.tsx",
      folder: "apps/web/src",
    });
  });

  test("selectRow supports plain click, cmd/ctrl toggle, shift range, and multi-target actions", () => {
    const ordered = ["a.ts", "b.ts", "c.ts", "d.ts"];
    let sel = selectRow(emptySelection, ordered, "a.ts", {
      meta: false,
      ctrl: false,
      shift: false,
    });
    expect([...sel.selected]).toEqual(["a.ts"]);

    sel = selectRow(sel, ordered, "c.ts", { meta: false, ctrl: false, shift: true });
    expect([...sel.selected]).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(targetPaths(ordered, sel.selected, "b.ts")).toEqual(["a.ts", "b.ts", "c.ts"]);
    // Clicking an unselected row targets only that row.
    expect(targetPaths(ordered, sel.selected, "d.ts")).toEqual(["d.ts"]);

    sel = selectRow(sel, ordered, "b.ts", { meta: true, ctrl: false, shift: false });
    expect([...sel.selected]).toEqual(["a.ts", "c.ts"]);

    sel = pruneSelection(sel, ["a.ts", "d.ts"]);
    expect([...sel.selected]).toEqual(["a.ts"]);
  });

  test("canCommitChanges blocks commits with empty message or unresolved conflicts", () => {
    expect(
      canCommitChanges({
        message: "   ",
        stagedCount: 1,
        changesCount: 0,
        conflictsCount: 0,
        amend: false,
      }),
    ).toBe(false);
    expect(
      canCommitChanges({
        message: "Fix bug",
        stagedCount: 1,
        changesCount: 0,
        conflictsCount: 1,
        amend: false,
      }),
    ).toBe(false);
    expect(
      canCommitChanges({
        message: "Fix bug",
        stagedCount: 0,
        changesCount: 0,
        conflictsCount: 0,
        amend: true,
      }),
    ).toBe(true);
  });
});
