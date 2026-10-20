import { BrowserIcon, TerminalIcon } from "@phosphor-icons/react";
import { beforeAll, expect, test } from "vitest";
import { workspaceActions } from "./actions.ts";
import { defineWorkspace } from "./definition.ts";
import { shownTab } from "./model.ts";
import { bottomOf, isShowing } from "./places.ts";
import { defineTabKind } from "./registry.ts";
import { WorkspaceStore } from "./store.ts";

/** In-memory storage, so what a reload reads back is observable. */
function memoryKeyValue() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const view = async () => ({ default: () => null });
const keys = (group: { tabs: readonly { key: string }[] }) => group.tabs.map((tab) => tab.key);
const definition = defineWorkspace({
  label: "Thread panel",
  launcher: "new-tab",
  initial: [{ kind: "changes", pinned: true }],
  bottom: { label: "Terminal panel", kinds: ["terminal"] },
  kinds: async () => ({
    default: [
      defineTabKind({ kind: "changes", label: "Changes", icon: BrowserIcon, load: view }),
      defineTabKind({ kind: "new-tab", label: "New tab", icon: BrowserIcon, load: view }),
      defineTabKind({ kind: "terminal", label: "Terminal", icon: TerminalIcon, load: view }),
    ],
  }),
});
beforeAll(() => definition.load());

/** A thread's workspace on a screen with room for the bottom panel (unless `fits` is false). */
function open(options: { storage?: ReturnType<typeof memoryKeyValue>; fits?: boolean } = {}) {
  const storage = options.storage ?? memoryKeyValue();
  const store = new WorkspaceStore({ storage });
  store.define("thread", definition);
  store.setBottomFits(options.fits ?? true);
  const side = () => store.get("thread");
  const bottom = () => bottomOf(store.get("thread"));
  return {
    store,
    storage,
    side,
    bottom,
    actions: workspaceActions(store, "thread"),
    from: (place: "side" | "bottom") => workspaceActions(store, "thread", place),
  };
}

test("terminals open in the bottom panel by default, and the toggle shows then hides it", () => {
  const { actions, side, bottom } = open();
  actions.toggleKind("terminal");
  expect(keys(bottom())).toEqual(["terminal"]);
  expect(bottom().open).toBe(true);
  expect(side().open).toBe(false);
  actions.toggleKind("terminal");
  expect(bottom().open).toBe(false);
  // Hiding keeps the terminal.
  expect(keys(bottom())).toEqual(["terminal"]);
});

test("with Side panel chosen, or no room for the bottom panel, terminals open beside", () => {
  const chosen = open();
  chosen.store.setPreferredPlace("side");
  chosen.actions.toggleKind("terminal");
  expect(keys(chosen.side())).toContain("terminal");
  expect(chosen.bottom().tabs).toHaveLength(0);

  const narrow = open({ fits: false });
  narrow.actions.open({ kind: "terminal", id: "pty-1" });
  expect(keys(narrow.side())).toContain("terminal:pty-1");
  expect(narrow.bottom().tabs).toHaveLength(0);
});

test("a terminal opened from a panel opens in that panel, whatever the setting", () => {
  const { from, side, bottom } = open();
  from("side").open({ kind: "terminal", id: "pty-1" });
  expect(keys(side())).toContain("terminal:pty-1");
  from("bottom").open({ kind: "terminal", id: "pty-2" });
  expect(keys(bottom())).toEqual(["terminal:pty-2"]);
});

test("a terminal open in one panel shows where it is instead of opening a second view", () => {
  const { actions, from, side, bottom } = open();
  actions.open({ kind: "terminal", id: "pty-1" });
  actions.setBottomOpen(false);
  from("side").open({ kind: "terminal", id: "pty-1" });
  expect(keys(side())).not.toContain("terminal:pty-1");
  expect(keys(bottom())).toEqual(["terminal:pty-1"]);
  expect(bottom().open).toBe(true);
});

test("a terminal moved between panels keeps its tab, title and place in line", () => {
  const { actions, store, side, bottom } = open();
  actions.open({ kind: "terminal", id: "pty-1", title: "dev server" });
  actions.open({ kind: "terminal", id: "pty-2" });

  actions.moveTo("terminal:pty-1", "side");
  const moved = side().tabs.find((tab) => tab.key === "terminal:pty-1");
  expect(moved?.title).toBe("dev server");
  expect(isShowing(store.get("thread"), "terminal:pty-1")).toBe(true);
  expect(keys(bottom())).toEqual(["terminal:pty-2"]);

  // Renaming it acts where it now is.
  actions.update("terminal:pty-1", { title: "server" });
  expect(side().tabs.find((tab) => tab.key === "terminal:pty-1")?.title).toBe("server");

  actions.moveTo("terminal:pty-2", "side");
  // The bottom panel, left empty, hides.
  expect(bottom().open).toBe(false);
  expect(shownTab(side())?.key).toBe("terminal:pty-2");
});

test("closing the bottom panel's last terminal hides it, and showing it again opens a fresh one", async () => {
  const { actions, bottom } = open();
  actions.open({ kind: "terminal", id: "pty-1" });
  expect(await actions.close("terminal:pty-1")).toBe(true);
  expect(bottom().open).toBe(false);
  actions.setBottomOpen(true);
  expect(keys(bottom())).toEqual(["terminal"]);
  expect(bottom().open).toBe(true);
});

test("the bottom panel's terminals, height and the chosen place are kept after a reload", () => {
  const first = open();
  first.actions.open({ kind: "terminal", id: "pty-1" });
  first.actions.setBottomHeight(412, true);
  first.store.setPreferredPlace("side");

  const reloaded = open({ storage: first.storage });
  expect(keys(reloaded.bottom())).toEqual(["terminal:pty-1"]);
  expect(reloaded.bottom().open).toBe(true);
  expect(reloaded.store.preferredBottom).toBe(412);
  expect(reloaded.store.preferredPlace).toBe("side");
});
