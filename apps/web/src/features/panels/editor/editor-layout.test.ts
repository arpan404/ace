import { groupsOf, type EditorLayout } from "@ace/ui-core/editor-workbench";
import { emptyWorkspace, type ScopeWorkspace } from "@ace/ui-core/workspace-tabs";
import { describe, expect, it } from "vitest";
import {
  editorLayoutOf,
  groupIds,
  openInLayout,
  openPaths,
  renameInLayout,
} from "./editor-layout.ts";

const withEditor = (data: unknown): ScopeWorkspace => ({
  ...emptyWorkspace,
  tabs: [{ key: "editor", kind: "editor", id: "editor", pinned: false, data }],
});

const strips = (layout: EditorLayout) =>
  groupsOf(layout).map((group) =>
    group.tabs.map((tab) => `${tab.path}${tab.preview ? " (preview)" : ""}`),
  );

describe("the editor's layout in its panel tab", () => {
  it("is one empty group for a thread with no editor, or one whose data is corrupt", () => {
    expect(strips(editorLayoutOf(emptyWorkspace))).toEqual([[]]);
    expect(strips(editorLayoutOf(withEditor({ root: "nonsense", focused: 4 })))).toEqual([[]]);
  });

  it("opens a glance as the group's preview, which the next glance replaces", () => {
    let layout = editorLayoutOf(emptyWorkspace);
    layout = openInLayout(layout, "src/a.ts", {});
    layout = openInLayout(layout, "src/b.ts", {});
    expect(strips(layout)).toEqual([["src/b.ts (preview)"]]);
    layout = openInLayout(layout, "src/c.ts", { keep: true });
    layout = openInLayout(layout, "src/d.ts", {});
    // The kept tab stays; the next glance takes the preview's place.
    expect(strips(layout)).toEqual([["src/d.ts (preview)", "src/c.ts"]]);
  });

  it("keeps a preview someone typed into when the next glance comes", () => {
    let layout = openInLayout(editorLayoutOf(emptyWorkspace), "a.ts", {});
    layout = openInLayout(layout, "b.ts", { unsaved: new Set(["a.ts"]) });
    expect(strips(layout)).toEqual([["a.ts", "b.ts (preview)"]]);
  });

  it("opens beside in a new group to the right", () => {
    const start = openInLayout(editorLayoutOf(emptyWorkspace), "a.ts", { keep: true });
    const layout = openInLayout(start, "b.ts", { keep: true, side: true });
    expect(strips(layout)).toEqual([["a.ts"], ["b.ts"]]);
    expect(layout.focused).toBe(groupsOf(layout)[1]?.id);
  });

  it("names new groups with ids no group or closed editor uses", () => {
    const start = openInLayout(editorLayoutOf(emptyWorkspace), "a.ts", { keep: true });
    const closed = [
      { group: "g2", index: 0, tab: { path: "x.ts", preview: false, pinned: false } },
    ];
    const next = groupIds({ ...start, closed });
    expect([next(), next()]).toEqual(["g3", "g4"]);
  });
});

describe("a rename in the explorer", () => {
  const layout: EditorLayout = {
    root: {
      kind: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        {
          kind: "group",
          id: "g1",
          tabs: [
            { path: "src/old/a.ts", preview: false, pinned: true },
            { path: "src/b.ts", preview: false, pinned: false },
          ],
          active: "src/old/a.ts",
          mru: ["src/old/a.ts", "src/b.ts"],
        },
        {
          kind: "group",
          id: "g2",
          tabs: [{ path: "src/old/c.ts", preview: true, pinned: false }],
          active: "src/old/c.ts",
          mru: ["src/old/c.ts"],
        },
      ],
    },
    focused: "g1",
    explorer: {
      ...editorLayoutOf(emptyWorkspace).explorer,
      expanded: ["src", "src/old", "src/old/deep"],
    },
    closed: [
      { group: "g1", index: 2, tab: { path: "src/old/d.ts", preview: false, pinned: false } },
    ],
  };

  it("moves every open editor inside a renamed folder, in place, with its pin", () => {
    const next = renameInLayout(layout, { from: "src/old", to: "src/new", folder: true });
    expect(openPaths(next)).toEqual(["src/new/a.ts", "src/b.ts", "src/new/c.ts"]);
    const [first] = groupsOf(next);
    expect(first?.active).toBe("src/new/a.ts");
    expect(first?.tabs[0]?.pinned).toBe(true);
    expect(first?.mru).toEqual(["src/new/a.ts", "src/b.ts"]);
    expect(next.explorer.expanded).toEqual(["src", "src/new", "src/new/deep"]);
    expect(next.closed[0]?.tab.path).toBe("src/new/d.ts");
  });

  it("leaves the layout as it was when nothing open is touched", () => {
    expect(renameInLayout(layout, { from: "docs/x.md", to: "docs/y.md", folder: false })).toBe(
      layout,
    );
  });

  it("folds two tabs into one when a file is renamed onto one the group shows", () => {
    const next = renameInLayout(layout, { from: "src/b.ts", to: "src/old/a.ts", folder: false });
    expect(groupsOf(next)[0]?.tabs.map((tab) => tab.path)).toEqual(["src/old/a.ts"]);
  });
});
