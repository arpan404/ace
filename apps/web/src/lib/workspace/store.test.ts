import { BrowserIcon, GitDiffIcon } from "@phosphor-icons/react";
import { expect, test } from "vitest";
import { workspaceActions } from "./actions.ts";
import { shownTab } from "./model.ts";
import { defineTabKind, defineWorkspace } from "./registry.ts";
import { WorkspaceStore } from "./store.ts";

/** In-memory storage, so what a reload reads back is observable. */
function memoryKeyValue() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const view = async () => ({ default: () => null });
const definition = defineWorkspace({
  label: "Thread panel",
  kinds: [
    defineTabKind({
      kind: "changes",
      label: "Changes",
      icon: GitDiffIcon,
      singleton: true,
      load: view,
    }),
    defineTabKind({
      kind: "preview",
      label: "Preview",
      icon: BrowserIcon,
      singleton: true,
      load: view,
    }),
    defineTabKind({ kind: "new-tab", label: "New tab", icon: BrowserIcon, load: view }),
    defineTabKind({
      kind: "terminal",
      label: "Terminal",
      icon: BrowserIcon,
      singleton: true,
      docks: ["bottom", "right"],
      load: view,
    }),
  ],
  launcher: "new-tab",
  initial: [{ kind: "changes", dock: "right", pinned: true }],
});

function open(storage = memoryKeyValue()) {
  const store = new WorkspaceStore({ storage });
  const scope = (id: string) => {
    store.define(id, definition);
    return workspaceActions(store, id);
  };
  return { store, storage, scope };
}

test("each thread keeps its own tabs and showing tab; one never leaks into another", () => {
  const { store, scope } = open();
  scope("a").open({ kind: "preview" });
  scope("b");
  expect(store.get("a").right.tabs.map((tab) => tab.key)).toEqual(["changes", "preview"]);
  expect(store.get("b").right.tabs.map((tab) => tab.key)).toEqual(["changes"]);
  expect(store.get("b").right.open).toBe(false);
});

test("tabs, the showing tab and sizes come back after a reload", () => {
  const first = open();
  const a = first.scope("a");
  a.open({ kind: "preview" });
  a.activate("changes");
  a.setSize("right", 610, true);

  const again = open(first.storage);
  again.store.define("a", definition);
  const restored = again.store.get("a");
  expect(restored.right.tabs.map((tab) => tab.key)).toEqual(["changes", "preview"]);
  expect(shownTab(restored.right)?.key).toBe("changes");
  expect(restored.right.open).toBe(true);
  expect(restored.right.size).toBe(610);
});

test("a resize becomes the size threads without one of their own start at", () => {
  const { store, scope } = open();
  scope("a").setSize("bottom", 300, true);
  expect(store.preferred.bottom).toBe(300);
  scope("b");
  expect(store.get("b").bottom.size).toBeUndefined();
});

test("a resize still moving is written once it ends", () => {
  const { storage, scope } = open();
  const a = scope("a");
  a.open({ kind: "preview" });
  const before = storage.data.get("ace.workspace");
  a.setSize("right", 700, false);
  expect(storage.data.get("ace.workspace")).toBe(before);
  a.setSize("right", 720, true);
  expect(storage.data.get("ace.workspace")).toContain("720");
});

test("the panel sizes an older build kept carry over once", () => {
  const storage = memoryKeyValue();
  storage.setItem(
    "ace.layout",
    JSON.stringify({ sidebarOpen: true, right: { open: true, tab: "agents", size: 640 } }),
  );
  const { store } = open(storage);
  expect(store.preferred).toEqual({ right: 640, bottom: 240 });
});

test("only the most recently changed threads are kept", () => {
  const storage = memoryKeyValue();
  const store = new WorkspaceStore({ storage, capacity: 2 });
  for (const id of ["a", "b", "c"]) {
    store.define(id, definition);
    workspaceActions(store, id).open({ kind: "preview" });
  }
  const again = new WorkspaceStore({ storage, capacity: 2 });
  expect(again.get("a").right.tabs).toEqual([]);
  expect(again.get("c").right.tabs.map((tab) => tab.key)).toEqual(["changes", "preview"]);
});

test("opening an empty dock opens a new tab to choose from, and new tabs never collide", () => {
  const { store, scope } = open();
  const a = scope("a");
  a.toggle("bottom");
  a.newTab("bottom");
  expect(store.get("a").bottom.tabs.map((tab) => tab.key)).toEqual(["new-tab:1", "new-tab:2"]);
  expect(store.get("a").bottom.open).toBe(true);
});

test("a tool's shortcut shows it, and pressed again while it shows hides its dock", () => {
  const { store, scope } = open();
  const a = scope("a");
  a.toggleKind("terminal");
  expect(store.get("a").bottom.open).toBe(true);
  expect(shownTab(store.get("a").bottom)?.key).toBe("terminal");
  a.toggleKind("terminal");
  expect(store.get("a").bottom.open).toBe(false);
  expect(store.get("a").bottom.tabs.map((tab) => tab.key)).toEqual(["terminal"]);
});

test("a tool moves only to a dock it may sit in", () => {
  const { store, scope } = open();
  const a = scope("a");
  a.open({ kind: "terminal" });
  a.moveToDock("terminal", "right");
  expect(store.get("a").right.tabs.map((tab) => tab.key)).toContain("terminal");
  a.moveToDock("changes", "bottom");
  expect(store.get("a").bottom.tabs.map((tab) => tab.key)).not.toContain("changes");
});
