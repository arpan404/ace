import { expect, test } from "vitest";
import type { KeyValueStorage } from "./storage.ts";
import { TabletWorkspaces, type TabletPanelView } from "./tablet-workspace.ts";

const memory = (): KeyValueStorage => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
};
const titles = (view: TabletPanelView) => view.tabs.map((tab) => tab.title);
const showing = (view: TabletPanelView) => view.tabs.find((tab) => tab.key === view.active)?.title;

test("a thread's panel first opens on Changes beside Files, both pinned", () => {
  const panels = new TabletWorkspaces();
  expect(panels.view("t1").open).toBe(false);
  panels.apply("t1", { op: "togglePanel" });
  const view = panels.view("t1");
  expect(view.open).toBe(true);
  expect(titles(view)).toEqual(["Changes", "Files"]);
  expect(view.tabs.every((tab) => tab.pinned)).toBe(true);
  expect(showing(view)).toBe("Changes");
});

test("opening a tool shows its tab, and a tool open already shows where it is", () => {
  const panels = new TabletWorkspaces();
  panels.apply("t1", { op: "open", kind: "terminal" });
  panels.apply("t1", { op: "open", kind: "browser" });
  panels.apply("t1", { op: "open", kind: "terminal" });
  const view = panels.view("t1");
  expect(titles(view)).toEqual(["Terminal", "Browser"]);
  expect(showing(view)).toBe("Terminal");
  expect(view.tools.find((tool) => tool.kind === "terminal")?.open).toBe(true);
});

test("a tool's shortcut hides the panel when its tab is showing, and shows it otherwise", () => {
  const panels = new TabletWorkspaces();
  panels.apply("t1", { op: "toggle", kind: "changes" });
  expect(panels.view("t1").open).toBe(true);
  panels.apply("t1", { op: "toggle", kind: "changes" });
  expect(panels.view("t1").open).toBe(false);
  panels.apply("t1", { op: "toggle", kind: "changes" });
  expect(showing(panels.view("t1"))).toBe("Changes");
});

test("a closed tab reopens where it stood, most recent first", () => {
  const panels = new TabletWorkspaces();
  for (const kind of ["terminal", "browser", "agents"]) panels.apply("t1", { op: "open", kind });
  panels.apply("t1", { op: "close", key: "browser" });
  panels.apply("t1", { op: "close", key: "terminal" });
  expect(titles(panels.view("t1"))).toEqual(["Agents"]);
  expect(panels.view("t1").canReopen).toBe(true);
  panels.apply("t1", { op: "reopen" });
  panels.apply("t1", { op: "reopen" });
  expect(titles(panels.view("t1"))).toEqual(["Terminal", "Browser", "Agents"]);
  expect(panels.view("t1").canReopen).toBe(false);
  expect(panels.apply("t1", { op: "reopen" })).toBe(false);
});

test("closing the last tab hides the panel", () => {
  const panels = new TabletWorkspaces();
  panels.apply("t1", { op: "open", kind: "terminal" });
  panels.apply("t1", { op: "close", key: "terminal" });
  expect(panels.view("t1").open).toBe(false);
});

test("close others keeps the pinned tabs and the one asked about, and each can come back", () => {
  const panels = new TabletWorkspaces();
  panels.apply("t1", { op: "panel", open: true });
  for (const kind of ["terminal", "browser", "agents"]) panels.apply("t1", { op: "open", kind });
  panels.apply("t1", { op: "closeOthers", key: "browser" });
  const view = panels.view("t1");
  expect(titles(view)).toEqual(["Changes", "Files", "Browser"]);
  expect(showing(view)).toBe("Browser");
  panels.apply("t1", { op: "reopen" });
  panels.apply("t1", { op: "reopen" });
  expect(titles(panels.view("t1"))).toEqual(["Changes", "Files", "Terminal", "Browser", "Agents"]);
});

test("reordering keeps pinned tabs first, and pinning moves a tab among them", () => {
  const panels = new TabletWorkspaces();
  panels.apply("t1", { op: "panel", open: true });
  panels.apply("t1", { op: "open", kind: "terminal" });
  panels.apply("t1", { op: "open", kind: "browser" });
  panels.apply("t1", { op: "move", key: "browser", to: 0 });
  expect(titles(panels.view("t1"))).toEqual(["Changes", "Files", "Browser", "Terminal"]);
  panels.apply("t1", { op: "pin", key: "terminal", pinned: true });
  expect(titles(panels.view("t1"))).toEqual(["Changes", "Files", "Terminal", "Browser"]);
  panels.apply("t1", { op: "move", key: "terminal", to: 0 });
  expect(titles(panels.view("t1"))).toEqual(["Terminal", "Changes", "Files", "Browser"]);
  panels.apply("t1", { op: "pin", key: "changes", pinned: false });
  expect(panels.view("t1").tabs.map((tab) => [tab.title, tab.pinned])).toEqual([
    ["Terminal", true],
    ["Files", true],
    ["Changes", false],
    ["Browser", false],
  ]);
});

test("each thread remembers its own tabs, width and panel across a relaunch", () => {
  const storage = memory();
  const first = new TabletWorkspaces({ storage });
  first.apply("t1", { op: "open", kind: "terminal" });
  first.apply("t1", { op: "size", size: 512.4 });
  first.apply("t2", { op: "open", kind: "browser" });
  first.apply("t2", { op: "panel", open: false });

  const again = new TabletWorkspaces({ storage });
  expect(titles(again.view("t1"))).toEqual(["Terminal"]);
  expect(again.view("t1").open).toBe(true);
  expect(again.view("t1").size).toBe(512);
  expect(titles(again.view("t2"))).toEqual(["Browser"]);
  expect(again.view("t2").open).toBe(false);
  // A thread never sized starts at the width last dragged anywhere.
  expect(again.view("t3").size).toBe(512);
});

test("a stored entry that doesn't parse starts fresh rather than failing", () => {
  const storage = memory();
  storage.setItem("ace.tablet-workspace", "{not json");
  const panels = new TabletWorkspaces({ storage });
  expect(panels.view("t1").tabs).toEqual([]);
  panels.apply("t1", { op: "open", kind: "files" });
  expect(titles(new TabletWorkspaces({ storage }).view("t1"))).toEqual(["Files"]);
});

test("only the most recently changed threads are remembered", () => {
  const storage = memory();
  const panels = new TabletWorkspaces({ storage, capacity: 2 });
  for (const scope of ["a", "b", "c"]) panels.apply(scope, { op: "open", kind: "files" });
  const again = new TabletWorkspaces({ storage, capacity: 2 });
  expect(again.view("a").tabs).toEqual([]);
  expect(titles(again.view("b"))).toEqual(["Files"]);
  expect(titles(again.view("c"))).toEqual(["Files"]);
});

test("a tool the app can't draw is never offered, opened or brought back", () => {
  const storage = memory();
  new TabletWorkspaces({ storage }).apply("t1", { op: "open", kind: "preview" });
  const panels = new TabletWorkspaces({ storage, available: ["changes", "files"] });
  expect(panels.view("t1").tabs).toEqual([]);
  expect(panels.view("t1").open).toBe(false);
  expect(panels.view("t1").tools.map((tool) => tool.label)).toEqual(["Changes", "Files"]);
  expect(panels.apply("t1", { op: "open", kind: "terminal" })).toBe(false);
  panels.setAvailable(["changes", "files", "preview"]);
  expect(panels.view("t1").tools.map((tool) => tool.label)).toContain("Run and preview");
});
