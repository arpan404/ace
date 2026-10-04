import { expect, test } from "vitest";
import {
  activateTab,
  closeOtherTabs,
  closeTab,
  cycleTab,
  moveTab,
  moveTabToDock,
  openTab,
  replaceTab,
  sanitize,
  seedWorkspace,
  setExpanded,
  setTabPinned,
  shownTab,
  type ScopeWorkspace,
} from "./model.ts";

const keys = (workspace: ScopeWorkspace, dock: "right" | "bottom" = "right") =>
  workspace[dock].tabs.map((tab) => tab.key);
const shown = (workspace: ScopeWorkspace, dock: "right" | "bottom" = "right") =>
  shownTab(workspace[dock])?.key;

const thread = () =>
  seedWorkspace([
    { kind: "changes", dock: "right", pinned: true },
    { kind: "agents", dock: "right", pinned: true },
    { kind: "terminal", dock: "bottom", pinned: true },
  ]);

test("a fresh scope holds its initial tabs, hidden, the first of each dock showing", () => {
  const workspace = thread();
  expect(keys(workspace)).toEqual(["changes", "agents"]);
  expect(shown(workspace)).toBe("changes");
  expect(shown(workspace, "bottom")).toBe("terminal");
  expect(workspace.right.open).toBe(false);
});

test("opening a resource that is already open shows it instead of a second tab", () => {
  let workspace = openTab(thread(), { kind: "file", id: "src/a.ts", dock: "right" });
  workspace = activateTab(workspace, "changes");
  workspace = openTab(workspace, {
    kind: "file",
    id: "src/a.ts",
    dock: "right",
    data: { line: 4 },
  });
  expect(keys(workspace)).toEqual(["changes", "agents", "file:src/a.ts"]);
  expect(shown(workspace)).toBe("file:src/a.ts");
  expect(workspace.right.tabs.at(-1)?.data).toEqual({ line: 4 });
  expect(workspace.right.open).toBe(true);
});

test("different resources of one kind open side by side, after the pinned tools", () => {
  let workspace = openTab(thread(), { kind: "file", id: "a.ts", dock: "right" });
  workspace = openTab(workspace, { kind: "file", id: "b.ts", dock: "right" });
  workspace = openTab(workspace, { kind: "logs", dock: "right", pinned: true });
  expect(keys(workspace)).toEqual(["changes", "agents", "logs", "file:a.ts", "file:b.ts"]);
});

test("closing the showing tab shows the one after it, or before it at the end", () => {
  let workspace = openTab(thread(), { kind: "file", id: "a", dock: "right" });
  workspace = openTab(workspace, { kind: "file", id: "b", dock: "right" });
  workspace = openTab(workspace, { kind: "file", id: "c", dock: "right" });
  workspace = activateTab(workspace, "file:b");
  workspace = closeTab(workspace, "file:b");
  expect(shown(workspace)).toBe("file:c");
  workspace = closeTab(workspace, "file:c");
  expect(shown(workspace)).toBe("file:a");
  expect(keys(workspace)).toEqual(["changes", "agents", "file:a"]);
});

test("closing a tab that isn't showing leaves the showing one alone", () => {
  let workspace = openTab(thread(), { kind: "file", id: "a", dock: "right" });
  workspace = activateTab(workspace, "changes");
  workspace = closeTab(workspace, "file:a");
  expect(shown(workspace)).toBe("changes");
});

test("closing a dock's last tab hides the dock and leaves full view", () => {
  let workspace = seedWorkspace([{ kind: "preview", dock: "right" }]);
  workspace = setExpanded(activateTab(workspace, "preview"), true);
  expect(workspace.expanded).toBe(true);
  workspace = closeTab(workspace, "preview");
  expect(workspace.right.open).toBe(false);
  expect(workspace.expanded).toBe(false);
});

test("full view needs something to show", () => {
  const empty = seedWorkspace([{ kind: "terminal", dock: "bottom" }]);
  expect(setExpanded(empty, true).expanded).toBe(false);
  const opened = setExpanded(thread(), true);
  expect(opened.expanded).toBe(true);
  expect(opened.right.open).toBe(true);
});

test("reordering keeps pinned tools ahead of resources", () => {
  let workspace = openTab(thread(), { kind: "file", id: "a", dock: "right" });
  workspace = openTab(workspace, { kind: "file", id: "b", dock: "right" });
  expect(keys(moveTab(workspace, "file:b", 0))).toEqual(["changes", "agents", "file:b", "file:a"]);
  expect(keys(moveTab(workspace, "changes", 3))).toEqual(["agents", "changes", "file:a", "file:b"]);
  expect(moveTab(workspace, "file:a", 2)).toBe(workspace);
});

test("pinning moves a tab to the end of the pinned tools; unpinning to the front of the rest", () => {
  let workspace = openTab(thread(), { kind: "file", id: "a", dock: "right" });
  workspace = openTab(workspace, { kind: "file", id: "b", dock: "right" });
  workspace = setTabPinned(workspace, "file:b", true);
  expect(keys(workspace)).toEqual(["changes", "agents", "file:b", "file:a"]);
  workspace = setTabPinned(workspace, "changes", false);
  expect(keys(workspace)).toEqual(["agents", "file:b", "changes", "file:a"]);
});

test("moving a tab to the other dock shows it there and its old dock shows a neighbour", () => {
  let workspace = activateTab(thread(), "terminal");
  workspace = openTab(workspace, { kind: "logs", dock: "bottom" });
  workspace = moveTabToDock(workspace, "logs", "right", 1);
  expect(keys(workspace)).toEqual(["changes", "agents", "logs"]);
  expect(shown(workspace)).toBe("logs");
  expect(keys(workspace, "bottom")).toEqual(["terminal"]);
  expect(shown(workspace, "bottom")).toBe("terminal");
});

test("the launcher becomes the tool picked from it, in its place", () => {
  let workspace = openTab(thread(), { kind: "file", id: "a", dock: "right" });
  workspace = openTab(workspace, { kind: "new-tab", id: "1", dock: "right" });
  workspace = openTab(workspace, { kind: "file", id: "b", dock: "right" });
  workspace = replaceTab(workspace, "new-tab:1", { kind: "preview" });
  expect(keys(workspace)).toEqual(["changes", "agents", "file:a", "preview", "file:b"]);
  expect(shown(workspace)).toBe("preview");
});

test("picking a tool that is open elsewhere moves it into the launcher's place instead of opening it twice", () => {
  let workspace = openTab(thread(), { kind: "new-tab", id: "1", dock: "right" });
  workspace = replaceTab(workspace, "new-tab:1", { kind: "terminal" });
  expect(keys(workspace)).toEqual(["changes", "agents", "terminal"]);
  expect(keys(workspace, "bottom")).toEqual([]);
  expect(workspace.bottom.open).toBe(false);
  expect(shown(workspace)).toBe("terminal");
});

test("picking a tool already open in the launcher's dock shows it where it is", () => {
  let workspace = openTab(thread(), { kind: "new-tab", id: "1", dock: "right" });
  workspace = replaceTab(workspace, "new-tab:1", { kind: "changes", data: { path: "a.ts" } });
  expect(keys(workspace)).toEqual(["changes", "agents"]);
  expect(shown(workspace)).toBe("changes");
  expect(workspace.right.tabs[0]?.data).toEqual({ path: "a.ts" });
});

test("close others keeps pinned tools and the chosen tab", () => {
  let workspace = openTab(thread(), { kind: "file", id: "a", dock: "right" });
  workspace = openTab(workspace, { kind: "file", id: "b", dock: "right" });
  workspace = closeOtherTabs(workspace, "file:a");
  expect(keys(workspace)).toEqual(["changes", "agents", "file:a"]);
  expect(shown(workspace)).toBe("file:a");
});

test("next and previous tab wrap around the dock", () => {
  const workspace = thread();
  expect(shown(cycleTab(workspace, "right", 1))).toBe("agents");
  expect(shown(cycleTab(workspace, "right", -1))).toBe("agents");
  expect(shown(cycleTab(cycleTab(workspace, "right", 1), "right", 1))).toBe("changes");
});

test("a stored workspace with duplicate tabs or a missing active tab comes back consistent", () => {
  const restored = sanitize({
    right: {
      tabs: [
        { key: "file:a", kind: "file", id: "a", pinned: false },
        { key: "changes", kind: "changes", id: "changes", pinned: true },
        { key: "file:a", kind: "file", id: "a", pinned: false },
      ],
      active: "gone",
      open: true,
    },
    bottom: { tabs: [], open: true },
    expanded: true,
    bottomMaximized: false,
    summaryPinned: false,
  });
  expect(keys(restored)).toEqual(["changes", "file:a"]);
  expect(shown(restored)).toBe("changes");
  expect(restored.bottom.open).toBe(false);
  expect(restored.expanded).toBe(true);
});
