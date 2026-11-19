import { expect, test } from "vitest";
import { workspaceActions } from "./actions.ts";
import { pullRequestTab } from "./pull-request-tab.ts";
import { WorkspaceStore } from "./store.ts";

const github = { forge: "github", host: "git.example.com", owner: "acme", name: "ace" } as const;
const gitlab = { ...github, forge: "gitlab" } as const;

test("the same host read through another provider opens its own pull request tab", () => {
  const store = new WorkspaceStore();
  const actions = workspaceActions(store, "ace");
  actions.open(pullRequestTab({ workspaceId: "ace", repository: github, number: 500 }));
  actions.open(pullRequestTab({ workspaceId: "ace", repository: gitlab, number: 500 }));
  const tabs = store.get("ace").tabs.filter((tab) => tab.kind === "pull-request");
  expect(tabs).toHaveLength(2);
  expect(tabs.map((tab) => tab.data)).toEqual([
    { workspaceId: "ace", repository: github, number: 500 },
    { workspaceId: "ace", repository: gitlab, number: 500 },
  ]);
});

test("opening the same pull request again shows the tab already open", () => {
  const store = new WorkspaceStore();
  const actions = workspaceActions(store, "ace");
  actions.open(pullRequestTab({ workspaceId: "ace", repository: gitlab, number: 500 }));
  actions.open(pullRequestTab({ workspaceId: "ace", repository: gitlab, number: 500 }));
  expect(store.get("ace").tabs.filter((tab) => tab.kind === "pull-request")).toHaveLength(1);
});
