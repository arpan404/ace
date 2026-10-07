import { expect, test } from "vitest";
import {
  activateTab,
  closeOtherTabs,
  closeTab,
  cycleTab,
  moveTab,
  openTab,
  replaceTab,
  sanitize,
  seedWorkspace,
  setExpanded,
  setTabPinned,
  shownTab,
  type ScopeWorkspace,
} from "./model.ts";

const keys = (workspace: ScopeWorkspace) => workspace.tabs.map((tab) => tab.key);
const shown = (workspace: ScopeWorkspace) => shownTab(workspace)?.key;

const thread = () =>
  seedWorkspace([
    { kind: "changes", pinned: true },
    { kind: "agents", pinned: true },
  ]);

test("a fresh scope holds its initial tabs, hidden, the first one showing", () => {
  const workspace = thread();
  expect(keys(workspace)).toEqual(["changes", "agents"]);
  expect(shown(workspace)).toBe("changes");
  expect(workspace.open).toBe(false);
});

test("opening a resource that is already open shows it instead of a second tab", () => {
  let workspace = openTab(thread(), { kind: "file", id: "src/a.ts" });
  workspace = activateTab(workspace, "changes");
  workspace = openTab(workspace, { kind: "file", id: "src/a.ts", data: { line: 4 } });
  expect(keys(workspace)).toEqual(["changes", "agents", "file:src/a.ts"]);
  expect(shown(workspace)).toBe("file:src/a.ts");
  expect(workspace.tabs.at(-1)?.data).toEqual({ line: 4 });
  expect(workspace.open).toBe(true);
});

test("different resources of one kind open side by side, after the pinned tools", () => {
  let workspace = openTab(thread(), { kind: "file", id: "a.ts" });
  workspace = openTab(workspace, { kind: "file", id: "b.ts" });
  workspace = openTab(workspace, { kind: "logs", pinned: true });
  expect(keys(workspace)).toEqual(["changes", "agents", "logs", "file:a.ts", "file:b.ts"]);
});

test("closing the showing tab shows the one after it, or before it at the end", () => {
  let workspace = openTab(thread(), { kind: "file", id: "a" });
  workspace = openTab(workspace, { kind: "file", id: "b" });
  workspace = openTab(workspace, { kind: "file", id: "c" });
  workspace = activateTab(workspace, "file:b");
  workspace = closeTab(workspace, "file:b");
  expect(shown(workspace)).toBe("file:c");
  workspace = closeTab(workspace, "file:c");
  expect(shown(workspace)).toBe("file:a");
  expect(keys(workspace)).toEqual(["changes", "agents", "file:a"]);
});

test("closing a tab that isn't showing leaves the showing one alone", () => {
  let workspace = openTab(thread(), { kind: "file", id: "a" });
  workspace = activateTab(workspace, "changes");
  workspace = closeTab(workspace, "file:a");
  expect(shown(workspace)).toBe("changes");
});

test("closing the panel's last tab hides it and leaves full view", () => {
  let workspace = seedWorkspace([{ kind: "preview" }]);
  workspace = setExpanded(activateTab(workspace, "preview"), true);
  expect(workspace.expanded).toBe(true);
  workspace = closeTab(workspace, "preview");
  expect(workspace.open).toBe(false);
  expect(workspace.expanded).toBe(false);
});

test("full view needs something to show", () => {
  expect(setExpanded(seedWorkspace([]), true).expanded).toBe(false);
  const opened = setExpanded(thread(), true);
  expect(opened.expanded).toBe(true);
  expect(opened.open).toBe(true);
});

test("reordering keeps pinned tools ahead of resources", () => {
  let workspace = openTab(thread(), { kind: "file", id: "a" });
  workspace = openTab(workspace, { kind: "file", id: "b" });
  expect(keys(moveTab(workspace, "file:b", 0))).toEqual(["changes", "agents", "file:b", "file:a"]);
  expect(keys(moveTab(workspace, "changes", 3))).toEqual(["agents", "changes", "file:a", "file:b"]);
  expect(moveTab(workspace, "file:a", 2)).toBe(workspace);
});

test("pinning moves a tab to the end of the pinned tools; unpinning to the front of the rest", () => {
  let workspace = openTab(thread(), { kind: "file", id: "a" });
  workspace = openTab(workspace, { kind: "file", id: "b" });
  workspace = setTabPinned(workspace, "file:b", true);
  expect(keys(workspace)).toEqual(["changes", "agents", "file:b", "file:a"]);
  workspace = setTabPinned(workspace, "changes", false);
  expect(keys(workspace)).toEqual(["agents", "file:b", "changes", "file:a"]);
});

test("the launcher becomes the tool picked from it, in its place", () => {
  let workspace = openTab(thread(), { kind: "file", id: "a" });
  workspace = openTab(workspace, { kind: "new-tab", id: "1" });
  workspace = openTab(workspace, { kind: "file", id: "b" });
  workspace = replaceTab(workspace, "new-tab:1", { kind: "preview" });
  expect(keys(workspace)).toEqual(["changes", "agents", "file:a", "preview", "file:b"]);
  expect(shown(workspace)).toBe("preview");
});

test("picking a tool that is already open shows it where it is instead of opening it twice", () => {
  let workspace = openTab(thread(), { kind: "new-tab", id: "1" });
  workspace = replaceTab(workspace, "new-tab:1", { kind: "changes", data: { path: "a.ts" } });
  expect(keys(workspace)).toEqual(["changes", "agents"]);
  expect(shown(workspace)).toBe("changes");
  expect(workspace.tabs[0]?.data).toEqual({ path: "a.ts" });
});

test("a terminal finishing startup in a hidden panel doesn't show the panel again", () => {
  let workspace = openTab(thread(), { kind: "terminal" });
  workspace = { ...workspace, open: false };
  workspace = replaceTab(workspace, "terminal", { kind: "terminal", id: "pty-1" });
  expect(keys(workspace)).toEqual(["changes", "agents", "terminal:pty-1"]);
  expect(workspace.open).toBe(false);
});

test("close others keeps pinned tools and the chosen tab", () => {
  let workspace = openTab(thread(), { kind: "file", id: "a" });
  workspace = openTab(workspace, { kind: "file", id: "b" });
  workspace = closeOtherTabs(workspace, "file:a");
  expect(keys(workspace)).toEqual(["changes", "agents", "file:a"]);
  expect(shown(workspace)).toBe("file:a");
});

test("next and previous tab wrap around", () => {
  const workspace = thread();
  expect(shown(cycleTab(workspace, 1))).toBe("agents");
  expect(shown(cycleTab(workspace, -1))).toBe("agents");
  expect(shown(cycleTab(cycleTab(workspace, 1), 1))).toBe("changes");
});

test("a stored workspace with duplicate tabs or a missing active tab comes back consistent", () => {
  const restored = sanitize({
    tabs: [
      { key: "file:a", kind: "file", id: "a", pinned: false },
      { key: "changes", kind: "changes", id: "changes", pinned: true },
      { key: "file:a", kind: "file", id: "a", pinned: false },
    ],
    active: "gone",
    open: true,
    expanded: true,
  });
  expect(keys(restored)).toEqual(["changes", "file:a"]);
  expect(shown(restored)).toBe("changes");
  expect(restored.expanded).toBe(true);
});

const tab = (kind: string, id = kind, pinned = false) => ({
  key: id === kind ? kind : `${kind}:${id}`,
  kind,
  id,
  pinned,
});

test("a workspace saved with a bottom panel moves its terminals and logs into the side panel", () => {
  const restored = sanitize({
    right: {
      tabs: [tab("changes", "changes", true), tab("files", "a")],
      active: "files:a",
      open: false,
      size: 610,
    },
    bottom: {
      tabs: [tab("terminal", "pty-1"), tab("logs")],
      active: "terminal:pty-1",
      open: true,
      size: 300,
    },
    expanded: false,
  });
  expect(keys(restored)).toEqual(["changes", "files:a", "terminal:pty-1", "logs"]);
  // The bottom panel showed and the side one didn't: its terminal shows, now beside the thread.
  expect(restored.open).toBe(true);
  expect(shown(restored)).toBe("terminal:pty-1");
  expect(restored.size).toBe(610);
});

test("a migrated workspace keeps showing the side panel's tab when both panels were open", () => {
  const restored = sanitize({
    right: { tabs: [tab("changes", "changes", true), tab("logs")], active: "changes", open: true },
    bottom: { tabs: [tab("logs"), tab("terminal")], active: "terminal", open: true },
    expanded: false,
  });
  // A tab in both panels comes over once.
  expect(keys(restored)).toEqual(["changes", "logs", "terminal"]);
  expect(shown(restored)).toBe("changes");
});
