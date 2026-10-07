import { FileIcon, TerminalIcon } from "@phosphor-icons/react";
import { expect, test } from "vitest";
import { workspaceActions } from "./actions.ts";
import { defineWorkspace } from "./definition.ts";
import type { WorkspaceTab } from "./model.ts";
import { defineTabKind, type CloseWarning } from "./registry.ts";
import { WorkspaceStore } from "./store.ts";

/** Let pending promise callbacks run (no timers involved). */
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const view = { load: () => Promise.resolve({ default: () => null }) };
/** Shells whose id starts with "live" are running: closing them asks. */
const shell = defineTabKind({
  kind: "shell",
  label: "Shell",
  icon: TerminalIcon,
  ...view,
  closeWarning: (_scope, tabs) =>
    tabs.some(({ tab }) => tab.id.startsWith("live"))
      ? { title: `End ${tabs.length}?`, description: "", confirm: "End" }
      : undefined,
});
const file = defineTabKind({ kind: "file", label: "File", icon: FileIcon, ...view });

function setup(kinds: () => Promise<{ default: readonly (typeof shell)[] }>) {
  const definition = defineWorkspace({
    label: "Side panel",
    launcher: "file",
    initial: [
      { kind: "file", id: "notes" },
      { kind: "shell", id: "live-1" },
      { kind: "shell", id: "pending-1" },
    ],
    kinds,
  });
  const store = new WorkspaceStore();
  store.define("thread", definition);
  const asked: CloseWarning[] = [];
  let answer: ((agreed: boolean) => void) | undefined;
  const ask = () => {
    store.setConfirm((warning) => {
      asked.push(warning);
      return new Promise((resolve) => (answer = resolve));
    });
  };
  const keys = () => store.get("thread").tabs.map((tab: WorkspaceTab) => tab.key);
  return {
    store,
    actions: workspaceActions(store, "thread"),
    asked,
    ask,
    agree: (agreed: boolean) => answer?.(agreed),
    keys,
  };
}

test("a yes to closing other tabs closes only the tabs it was asked about", async () => {
  const { actions, asked, ask, agree, keys } = setup(() =>
    Promise.resolve({ default: [shell, file] }),
  );
  ask();
  expect(keys()).toEqual(["file:notes", "shell:live-1", "shell:pending-1"]);

  const closing = actions.closeOthers("file:notes");
  await settle();
  expect(asked).toHaveLength(1);
  // While the question is open, the waiting shell becomes a running one and another opens.
  actions.replace("shell:pending-1", { kind: "shell", id: "live-2" });
  actions.open({ kind: "shell", id: "live-3" });
  agree(true);
  expect(await closing).toBe(true);
  // Only live-1 was asked about; the replacement and the new shell keep running.
  expect(keys()).toEqual(["file:notes", "shell:live-2", "shell:live-3"]);
});

test("closing before the kinds have loaded waits for them, then asks; no dialog yet means wait, not yes", async () => {
  let loaded: ((module: { default: readonly (typeof shell)[] }) => void) | undefined;
  const { actions, asked, ask, agree, keys } = setup(
    () => new Promise((resolve) => (loaded = resolve)),
  );
  const closing = actions.close("shell:live-1");
  await settle();
  // Unknown kinds aren't taken to mean "nothing to lose".
  expect(keys()).toContain("shell:live-1");

  loaded?.({ default: [shell, file] });
  await settle();
  // The dialog hasn't registered: the question waits for it instead of closing.
  expect(keys()).toContain("shell:live-1");
  ask();
  expect(asked).toHaveLength(1);
  agree(false);
  expect(await closing).toBe(false);
  expect(keys()).toContain("shell:live-1");
});

test("when the kinds can't load, a close keeps the tab", async () => {
  const { actions, keys } = setup(() => Promise.reject(new Error("offline")));
  expect(await actions.close("shell:live-1")).toBe(false);
  expect(keys()).toContain("shell:live-1");
});
