import { expect, test } from "vitest";
import { defineWorkspace, WorkspaceStore } from "@/lib/workspace/index.ts";
import { workspaceActions } from "@/lib/workspace/actions.ts";
import { migrateThreadWorkspace } from "./migrate.ts";

const definition = defineWorkspace({
  label: "Thread panel",
  launcher: "new-tab",
  initial: [
    { kind: "work", pinned: true },
    { kind: "changes", pinned: true },
  ],
  kinds: async () => ({ default: [] }),
  migrate: migrateThreadWorkspace,
});
function restored(active: string, floating: boolean) {
  const stored = JSON.stringify({
    preferred: { right: 520 },
    scopes: [
      [
        "thread",
        {
          tabs: [
            { key: "changes", kind: "changes", id: "changes", pinned: true },
            {
              key: "agents",
              kind: "agents",
              id: "agents",
              pinned: true,
              ui: { collapsed: ["root"], selected: "child" },
            },
            { key: "browser", kind: "browser", id: "browser", pinned: false },
          ],
          active,
          open: !floating,
          expanded: false,
          workCard: {
            open: floating,
            sections: { "pull-requests": true },
            search: "",
            scrollTop: 240,
          },
        },
      ],
    ],
  });
  const data = new Map([["ace.workspace", stored]]);
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  const store = new WorkspaceStore({ storage });
  store.define("thread", definition);
  return { store, storage };
}

test("a saved Agents view comes back as Work with the tree folds and scroll position retained", () => {
  const { store, storage } = restored("agents", false);
  expect(store.get("thread").active).toBe("work");
  expect(store.get("thread").tabs.map((tab) => tab.kind)).toEqual(["work", "changes", "browser"]);
  expect(store.get("thread").tabs[0]?.ui).toEqual({ collapsed: ["root"], selected: "child" });
  workspaceActions(store, "thread").open({ kind: "browser" });
  const reload = new WorkspaceStore({ storage });
  reload.define("thread", definition);
  expect(reload.get("thread").active).toBe("browser");
  expect(reload.get("thread").workCard?.scrollTop).toBe(240);
});

test("a saved floating Work view opens Work and a saved Browser view keeps Browser selected", () => {
  expect(restored("browser", true).store.get("thread")).toMatchObject({
    active: "work",
    open: true,
  });
  expect(restored("browser", false).store.get("thread")).toMatchObject({
    active: "browser",
    open: true,
  });
});

test("reopening a panel after all tools close defaults to Work, and an empty saved panel restores it", async () => {
  const store = new WorkspaceStore();
  store.define("thread", definition);
  const actions = workspaceActions(store, "thread");
  await actions.close("work");
  await actions.close("changes");
  actions.setOpen(true);
  expect(store.get("thread")).toMatchObject({ active: "work", open: true });
  const saved = JSON.stringify({
    preferred: { right: 520 },
    scopes: [["thread", { tabs: [], open: false, expanded: false }]],
  });
  const reload = new WorkspaceStore({ storage: { getItem: () => saved, setItem() {} } });
  reload.define("thread", definition);
  expect(reload.get("thread").tabs.map((tab) => tab.kind)).toEqual(["work"]);
});
