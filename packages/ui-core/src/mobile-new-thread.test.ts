import { CatalogModel, type ProviderKind, type ProviderStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  newThreadAgents,
  newThreadModelList,
  newThreadProjects,
  selectNewThreadAgent,
  type NewThreadModelRow,
} from "./mobile-new-thread.ts";

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

test("the model in use comes first and shows even when it is legacy", () => {
  const models = [
    listed("A"),
    listed("B"),
    listed("C"),
    listed("Default", { isDefault: true }),
    listed("D"),
    listed("Old", { legacy: true }),
  ];
  const list = newThreadModelList(models, { key: "Old", account: "work" });
  expect(list.models.slice(0, 2).map((entry) => entry.label)).toEqual(["Old", "Default"]);
  expect(list.lead).toBeGreaterThanOrEqual(1);
  const other = newThreadModelList(models, { key: "Old", account: "personal" });
  expect(other.models[0]?.label).toBe("Default");
});

test("a list barely longer than the lead shows whole", () => {
  const models = ["A", "B", "C", "D", "E"].map((label) => listed(label));
  expect(newThreadModelList(models, undefined).lead).toBe(5);
});
