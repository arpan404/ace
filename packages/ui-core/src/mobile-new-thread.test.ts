import { CatalogModel, type ProviderKind, type ProviderStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  newThreadAgents,
  newThreadModelList,
  newThreadPickerAgents,
  newThreadProjects,
  selectNewThreadAgent,
  type NewThreadModelRow,
} from "./mobile-new-thread.ts";
import { newThreadTabs } from "./mobile-new-thread-tabs.ts";

const row = (provider: ProviderKind, fields: Partial<ProviderStatus> = {}): ProviderStatus => ({
  provider,
  runtime: "cli",
  installed: true,
  auth: "logged_in",
  loginHint: "",
  stale: false,
  refreshing: false,
  ...fields,
});

const model = (
  provider: ProviderKind,
  id: string,
  isDefault = false,
  efforts: string[] = [],
  extra: Record<string, unknown> = {},
) =>
  CatalogModel.parse({
    id,
    displayName: id,
    provider,
    instance: provider,
    nativeModelId: id,
    efforts: efforts.map((effort) => ({ id: effort, label: effort, level: effort })),
    serviceTiers: [],
    inputModalities: ["text"],
    isDefault,
    hidden: false,
    deprecated: false,
    raw: { json: "{}", truncated: false },
    ...extra,
  });

const agents = () =>
  newThreadAgents({
    statuses: [
      row("claude"),
      row("codex", { auth: "logged_out" }),
      row("antigravity", { installed: false, installHint: "Install Antigravity" }),
      row("cursor", { enabled: false }),
    ],
    accounts: [],
    catalog: {
      models: [
        model("claude", "opus", true, ["low", "high"]),
        model("claude", "sonnet"),
        model("codex", "gpt-6"),
      ],
      instances: [],
    },
    now: 0,
  });

test("a signed-out or missing CLI is listed but can't start a thread, and says why", () => {
  const rows = agents().providers;
  expect(rows.map((entry) => [entry.provider, entry.ready, entry.reason])).toEqual([
    ["claude", true, undefined],
    ["codex", false, "Signed out. Sign in on your computer."],
    ["antigravity", false, "Not installed on this computer"],
  ]);
  expect(rows[0]?.models.map((entry) => entry.label)).toEqual(["Opus", "Sonnet"]);
});

test("the picker leaves out a CLI that isn't on the computer unless the draft names it", () => {
  const rows = agents().providers;
  expect(newThreadPickerAgents(rows, undefined).map((entry) => entry.provider)).toEqual([
    "claude",
    "codex",
  ]);
  expect(newThreadPickerAgents(rows, "antigravity").map((entry) => entry.provider)).toEqual([
    "claude",
    "codex",
    "antigravity",
  ]);
});

test("the picker opens with Favorites, then a tab per account, and an agent that can't start says why", () => {
  const tabs = newThreadTabs(agents(), { favorites: [], current: undefined });
  expect(tabs[0]).toMatchObject({ id: "favorites", models: [] });
  const claude = tabs.find((tab) => tab.provider === "claude");
  expect(claude?.reason).toBeUndefined();
  expect(claude?.models.length).toBe(2);
  expect(tabs.find((tab) => tab.provider === "codex")?.reason).toBe(
    "Signed out. Sign in on your computer.",
  );
  const starred = newThreadTabs(agents(), {
    favorites: [claude?.models[1]?.key ?? ""],
    current: undefined,
  });
  expect(starred[0]?.models).toEqual([claude?.models[1]]);
});

test("choosing an unready agent is refused with its reason instead of starting elsewhere", () => {
  const refused = selectNewThreadAgent(agents(), { provider: "codex" });
  expect(refused).toEqual({ ok: false, reason: "Codex: Signed out. Sign in on your computer." });
});

test("with nothing chosen the first ready agent starts on its default model and effort", () => {
  const start = selectNewThreadAgent(agents(), {});
  expect(start.ok && [start.provider, start.model.id, start.effort]).toEqual([
    "claude",
    "opus",
    "low",
  ]);
  const picked = selectNewThreadAgent(agents(), {
    provider: "claude",
    model: start.ok ? agents().providers[0]?.models[1]?.key : undefined,
  });
  expect(picked.ok && picked.model.id).toBe("sonnet");
});

test("projects with recent threads come first, newest activity on top, then the rest by name", () => {
  const rows = newThreadProjects(
    [
      { id: "web", name: "web", path: "/w" },
      { id: "api", name: "api", path: "/a" },
      { id: "ace", name: "ace-next", path: "/ace" },
      { id: "docs", name: "docs", path: "/d" },
    ],
    [
      { workspaceId: "docs", at: 5 },
      { workspaceId: "ace", at: 9 },
      { workspaceId: "docs", at: 2 },
    ],
  );
  expect(rows.map((entry) => [entry.id, entry.recent])).toEqual([
    ["ace", true],
    ["docs", true],
    ["api", false],
    ["web", false],
  ]);
});

test("a speed the person turned on starts the thread on that tier; one the model lacks is left out", () => {
  const fast = {
    serviceTiers: [
      { id: "priority", name: "Fast", speed: "fast", parameters: { serviceTier: "priority" } },
    ],
  };
  const tuned = newThreadAgents({
    statuses: [row("codex")],
    accounts: [],
    catalog: { models: [model("codex", "gpt-6", true, [], fast)], instances: [] },
    now: 0,
  });
  expect(tuned.providers[0]?.models[0]?.speeds.map((tier) => tier.label)).toEqual([
    "Standard",
    "Fast",
  ]);
  const start = selectNewThreadAgent(tuned, { speed: "fast" });
  expect(start.ok && start.serviceTier).toBe("priority");
  const standard = selectNewThreadAgent(tuned, { speed: "standard" });
  expect(standard.ok && standard.serviceTier).toBeUndefined();
  const unknown = selectNewThreadAgent(tuned, { speed: "ultrafast" });
  expect(unknown.ok && unknown.serviceTier).toBeUndefined();
});

const listed = (label: string, fields: Partial<NewThreadModelRow> = {}): NewThreadModelRow => ({
  key: label,
  label,
  account: "work",
  efforts: [],
  defaultEffort: undefined,
  speeds: [],
  defaultSpeed: "standard",
  isDefault: false,
  legacy: false,
  ...fields,
});

test("an agent's long model list leads with the default and keeps the rest behind More models", () => {
  const models = [
    listed("A"),
    listed("B"),
    listed("Old", { legacy: true }),
    listed("C"),
    listed("Default", { isDefault: true }),
    listed("D"),
    listed("E"),
  ];
  const list = newThreadModelList(models, undefined);
  expect(list.models.map((entry) => entry.label)).toEqual([
    "Default",
    "A",
    "B",
    "C",
    "D",
    "E",
    "Old",
  ]);
  expect(list.lead).toBe(4);
});

const order = (list: { models: NewThreadModelRow[] }) => list.models.map((entry) => entry.label);

test("picking a model never reorders the list, and the lead reaches the model in use", () => {
  const models = [
    listed("A"),
    listed("B"),
    listed("C"),
    listed("Default", { isDefault: true }),
    listed("D"),
    listed("Old", { legacy: true }),
  ];
  const none = newThreadModelList(models, undefined);
  const inUse = newThreadModelList(models, { key: "Old", account: "work" });
  expect(order(inUse)).toEqual(order(none));
  expect(order(inUse).slice(0, inUse.lead)).toContain("Old");
  const elsewhere = newThreadModelList(models, { key: "Old", account: "personal" });
  expect(order(elsewhere).slice(0, elsewhere.lead)).not.toContain("Old");
});

test("a list barely longer than the lead shows whole", () => {
  const models = ["A", "B", "C", "D", "E"].map((label) => listed(label));
  expect(newThreadModelList(models, undefined).lead).toBe(5);
});
