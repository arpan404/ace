import { BrowserIcon, GitDiffIcon } from "@phosphor-icons/react";
import { beforeAll, expect, test } from "vitest";
import { workspaceActions } from "./actions.ts";
import { shownTab } from "./model.ts";
import { defineWorkspace } from "./definition.ts";
import { defineTabKind } from "./registry.ts";
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
const kinds = [
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
    load: view,
  }),
];
const definition = defineWorkspace({
  label: "Thread panel",
  kinds: async () => ({ default: kinds }),
  launcher: "new-tab",
  initial: [{ kind: "changes", pinned: true }],
});
// The kinds load after a screen's first paint; these tests act once they have.
beforeAll(() => definition.load());

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
  expect(store.get("a").tabs.map((tab) => tab.key)).toEqual(["changes", "preview"]);
  expect(store.get("b").tabs.map((tab) => tab.key)).toEqual(["changes"]);
  expect(store.get("b").open).toBe(false);
});

test("tabs, the showing tab and the width come back after a reload", () => {
  const first = open();
  const a = first.scope("a");
  a.open({ kind: "preview" });
  a.activate("changes");
  a.setSize(610, true);

  const again = open(first.storage);
  again.store.define("a", definition);
  const restored = again.store.get("a");
  expect(restored.tabs.map((tab) => tab.key)).toEqual(["changes", "preview"]);
  expect(shownTab(restored)?.key).toBe("changes");
  expect(restored.open).toBe(true);
  expect(restored.size).toBe(610);
});

test("Work folds, selection and scroll are isolated and restored in the current tab state", () => {
  const first = open();
  const a = first.scope("a");
  a.open({ kind: "work" });
  a.updateUi("work", {
    collapsed: ["root"],
    selected: "child",
    sections: { "pull-requests": true },
  });
  a.updateUi("work", { scrollTop: 240 });
  first.scope("b").open({ kind: "work" });
  expect(first.store.get("b").tabs.find((tab) => tab.key === "work")?.ui).toBeUndefined();
  const again = open(first.storage);
  expect(shownTab(again.store.get("a"))?.key).toBe("work");
  expect(again.store.get("a").tabs.find((tab) => tab.key === "work")?.ui).toEqual({
    collapsed: ["root"],
    selected: "child",
    sections: { "pull-requests": true },
    scrollTop: 240,
  });
});

test("a resize becomes the width threads without one of their own start at", () => {
  const { store, scope } = open();
  scope("a").setSize(600, true);
  expect(store.preferred).toBe(600);
  scope("b");
  expect(store.get("b").size).toBeUndefined();
});

test("a resize still moving is written once it ends", () => {
  const { storage, scope } = open();
  const a = scope("a");
  a.open({ kind: "preview" });
  const before = storage.data.get("ace.workspace");
  a.setSize(700, false);
  expect(storage.data.get("ace.workspace")).toBe(before);
  a.setSize(720, true);
  expect(storage.data.get("ace.workspace")).toContain("720");
});

test("only the most recently changed threads are kept", () => {
  const storage = memoryKeyValue();
  const store = new WorkspaceStore({ storage, capacity: 2 });
  for (const id of ["a", "b", "c"]) {
    store.define(id, definition);
    workspaceActions(store, id).open({ kind: "preview" });
  }
  const again = new WorkspaceStore({ storage, capacity: 2 });
  expect(again.get("a").tabs).toEqual([]);
  expect(again.get("c").tabs.map((tab) => tab.key)).toEqual(["changes", "preview"]);
});

test("new tabs to choose from never collide", () => {
  const { store, scope } = open();
  const a = scope("a");
  a.newTab();
  a.newTab();
  expect(store.get("a").tabs.map((tab) => tab.key)).toEqual(["changes", "new-tab:1", "new-tab:2"]);
  expect(store.get("a").open).toBe(true);
});

test("showing an empty panel opens a new tab to choose from", () => {
  const store = new WorkspaceStore({ storage: memoryKeyValue() });
  const bare = defineWorkspace({
    label: "Panel",
    kinds: async () => ({ default: kinds }),
    launcher: "new-tab",
    initial: [],
  });
  store.define("a", bare);
  workspaceActions(store, "a").toggle();
  expect(store.get("a").tabs.map((tab) => tab.key)).toEqual(["new-tab:1"]);
  expect(store.get("a").open).toBe(true);
});

test("a tool's shortcut shows it, and pressed again while it shows hides the panel", () => {
  const { store, scope } = open();
  const a = scope("a");
  a.toggleKind("terminal");
  expect(store.get("a").open).toBe(true);
  expect(shownTab(store.get("a"))?.key).toBe("terminal");
  a.toggleKind("terminal");
  expect(store.get("a").open).toBe(false);
  expect(store.get("a").tabs.map((tab) => tab.key)).toEqual(["changes", "terminal"]);
});

test("a tool asked for before the kinds have loaded opens once they have", async () => {
  const { promise, resolve: arrive } = Promise.withResolvers<{ default: typeof kinds }>();
  const late = defineWorkspace({
    label: "Thread panel",
    kinds: () => promise,
    launcher: "new-tab",
    initial: [],
  });
  const store = new WorkspaceStore({ storage: memoryKeyValue() });
  store.define("a", late);
  workspaceActions(store, "a").toggleKind("terminal");
  expect(store.get("a").open).toBe(false);

  arrive({ default: kinds });
  await late.load();
  expect(store.get("a").tabs.map((tab) => tab.key)).toEqual(["terminal"]);
  expect(store.get("a").open).toBe(true);
});

test.each([
  "invalid JSON",
  JSON.stringify({ preferred: { right: 900 }, scopes: [["a", { tabs: "invalid", open: true }]] }),
])("an unparseable stored workspace opens the default layout (%s)", (saved) => {
  const storage = memoryKeyValue();
  storage.setItem("ace.workspace", saved);
  const { store, scope } = open(storage);
  scope("a").setOpen(true);
  expect(store.preferred).toBe(520);
  expect(store.get("a").tabs.map((tab) => tab.key)).toEqual(["changes"]);
  expect(shownTab(store.get("a"))?.key).toBe("changes");
  expect(store.get("a").open).toBe(true);
});
