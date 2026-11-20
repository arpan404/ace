import { describe, expect, it } from "vitest";
import type { WorkspaceTab } from "../workspace-tabs.ts";
import { focusedGroup, migratePanelTabs, parseLayout } from "./index.ts";
import { strip } from "./layout.fixture.ts";

const filesTab = (data?: unknown): WorkspaceTab => ({
  key: "files",
  kind: "files",
  id: "files",
  pinned: true,
  ...(data === undefined ? {} : { data }),
});
const fileTab = (
  path: string,
  data: Record<string, unknown> = {},
  pinned = false,
): WorkspaceTab => ({
  key: `files:file:${path}`,
  kind: "files",
  id: `file:${path}`,
  pinned,
  data: { path, ...data },
});
const tool = (kind: string): WorkspaceTab => ({ key: kind, kind, id: kind, pinned: true });

describe("moving per-file panel tabs into the editor", () => {
  it("keeps the tabs' order and preview flags in one group", () => {
    const tabs = [
      tool("summary"),
      filesTab(),
      fileTab("src/a.ts"),
      tool("changes"),
      fileTab("src/b.ts", { preview: true }),
      fileTab("c.md"),
    ];
    const migration = migratePanelTabs({ tabs, active: "changes" }, "g1");
    expect(strip(migration!.layout, "g1")).toEqual(["src/a.ts", "~src/b.ts", "c.md"]);
    expect(migration!.layout.focused).toBe("g1");
  });

  it("replaces the Files tab and every file tab, and takes the Files tab's place", () => {
    const tabs = [tool("summary"), filesTab(), tool("changes"), fileTab("a.ts"), tool("browser")];
    const migration = migratePanelTabs({ tabs, active: "summary" }, "g1");
    expect(migration).toMatchObject({
      replaced: ["files", "files:file:a.ts"],
      index: 1,
      wasActive: false,
    });
  });

  it("the file tab that was showing is the editor's active editor", () => {
    const tabs = [filesTab(), fileTab("a.ts"), fileTab("b.ts")];
    const migration = migratePanelTabs({ tabs, active: "files:file:b.ts" }, "g1");
    expect(focusedGroup(migration!.layout)).toMatchObject({
      active: "b.ts",
      mru: ["b.ts", "a.ts"],
    });
    expect(migration!.wasActive).toBe(true);
  });

  it("of several stored previews the showing one stays the preview, else the last", () => {
    const tabs = [
      fileTab("a.ts", { preview: true }),
      fileTab("b.ts", { preview: true }),
      fileTab("c.ts", { preview: true }),
    ];
    expect(
      strip(migratePanelTabs({ tabs, active: "files:file:a.ts" }, "g1")!.layout, "g1"),
    ).toEqual(["~a.ts", "b.ts", "c.ts"]);
    expect(strip(migratePanelTabs({ tabs, active: undefined }, "g1")!.layout, "g1")).toEqual([
      "a.ts",
      "b.ts",
      "~c.ts",
    ]);
  });

  it("pinned file tabs stay pinned and come first", () => {
    const tabs = [fileTab("a.ts"), fileTab("p.ts", {}, true)];
    expect(strip(migratePanelTabs({ tabs, active: undefined }, "g1")!.layout, "g1")).toEqual([
      "^p.ts",
      "a.ts",
    ]);
  });

  it("unsaved drafts move out for the draft store; untouched drafts don't", () => {
    const tabs = [
      fileTab("a.ts", { draft: { text: "new", original: "old", version: "v1" } }),
      fileTab("b.ts", { draft: { text: "same", original: "same", version: "v2" } }),
    ];
    const migration = migratePanelTabs({ tabs, active: undefined }, "g1");
    expect(migration!.drafts).toEqual([
      { path: "a.ts", text: "new", original: "old", version: "v1" },
    ]);
    expect(JSON.stringify(migration!.layout)).not.toContain("new");
  });

  it("the explorer keeps the showing tab's tree: side, filter, open folders and scroll", () => {
    const tabs = [
      filesTab({ query: "old" }),
      fileTab("a.ts", {
        side: "search",
        query: "relay",
        expanded: ["src", "src/lib"],
        treeScroll: 80,
      }),
    ];
    const migration = migratePanelTabs({ tabs, active: "files:file:a.ts" }, "g1");
    expect(migration!.layout.explorer).toMatchObject({
      side: "search",
      query: "relay",
      expanded: ["src", "src/lib"],
      scroll: 80,
    });
  });

  it("a Files tab with no files open becomes an empty editor", () => {
    const migration = migratePanelTabs(
      { tabs: [tool("summary"), filesTab()], active: "files" },
      "g1",
    );
    expect(migration).toMatchObject({ replaced: ["files"], index: 1, wasActive: true });
    expect(strip(migration!.layout, "g1")).toEqual([]);
  });

  it("file tabs with broken data are left out, and a repeated path opens once", () => {
    const broken: WorkspaceTab = {
      key: "files:file:x",
      kind: "files",
      id: "file:x",
      pinned: false,
      data: { path: 5 },
    };
    const tabs = [fileTab("a.ts"), broken, fileTab("a.ts", { preview: "maybe" })];
    const migration = migratePanelTabs({ tabs, active: undefined }, "g1");
    expect(strip(migration!.layout, "g1")).toEqual(["a.ts"]);
    expect(migration!.replaced).toContain("files:file:x");
  });

  it("a thread with no Files tabs has nothing to move", () => {
    expect(
      migratePanelTabs({ tabs: [tool("summary"), tool("browser")], active: "summary" }, "g1"),
    ).toBeUndefined();
  });

  it("the migrated layout survives a reload unchanged", () => {
    const tabs = [filesTab(), fileTab("a.ts"), fileTab("b.ts", { preview: true })];
    const layout = migratePanelTabs({ tabs, active: "files:file:b.ts" }, "g1")!.layout;
    expect(parseLayout(JSON.parse(JSON.stringify(layout)), "x")).toEqual(layout);
  });
});
