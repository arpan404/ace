import { CatalogModel, type ProviderKind } from "@ace/protocol";
import { AccountSummary } from "@ace/protocol/accounts";
import { expect, test } from "vitest";
import { accountView } from "./accounts.ts";
import {
  choiceLine,
  choiceSelection,
  currentModelChoice,
  defaultModelChoice,
  modelChoices,
  newThreadOptions,
  optionEffort,
  threadEffortControl,
  effortLabel,
  recordedChoice,
} from "./models.ts";

const account = (
  id: string,
  provider: ProviderKind,
  windows: Record<string, { usedPercent: number; resetsAt: number | null }>,
  availability: "available" | "exhausted" | "logged_out" = "available",
) =>
  accountView(
    AccountSummary.parse({
      id,
      provider,
      label: id.split("-")[1] ?? id,
      availability,
      quota: {
        auth: availability === "logged_out" ? "logged_out" : "logged_in",
        observedAt: 0,
        windows,
        usage: {},
      },
    }),
  );

const model = (provider: ProviderKind, instance: string, id: string, isDefault = false) =>
  CatalogModel.parse({
    id: `${instance}:${id}`,
    displayName: id,
    provider,
    instance,
    nativeModelId: id,
    reasoningEfforts: [],
    serviceTiers: [],
    inputModalities: ["text"],
    isDefault,
    hidden: false,
    deprecated: false,
    raw: { json: "{}", truncated: false },
  });

test("quota windows read in words and the shortest window comes first", () => {
  const claude = account("claude-personal", "claude", {
    seven_day: { usedPercent: 41, resetsAt: 9 },
    five_hour: { usedPercent: 62.4, resetsAt: 5 },
  });
  const codex = account("codex-team", "codex", {
    "codex:secondary": { usedPercent: 12, resetsAt: null },
    "codex:primary": { usedPercent: 100, resetsAt: 3 },
  });

  expect(claude.windows.map((w) => [w.label, w.usedPercent])).toEqual([
    ["5-hour", 62],
    ["Weekly", 41],
  ]);
  expect(codex.windows.map((w) => w.label)).toEqual(["5-hour", "Weekly"]);
});

test("each model is offered on the account that serves it, with that account's usage", () => {
  const choices = modelChoices(
    [model("claude", "claude-personal", "opus", true), model("claude", "claude-work", "opus")],
    [
      account("claude-personal", "claude", { five_hour: { usedPercent: 62, resetsAt: 5 } }),
      account("claude-work", "claude", { five_hour: { usedPercent: 23, resetsAt: 5 } }),
    ],
    0,
  );

  expect(choices.map((c) => [c.model, c.account, c.note, c.used])).toEqual([
    ["opus", "personal", "62% of 5-hour window used", 0.62],
    ["opus", "work", "23% of 5-hour window used", 0.23],
  ]);
});

test("a signed-out account offers nothing and an exhausted one can't be the default", () => {
  const choices = modelChoices(
    [
      model("codex", "codex-team", "gpt", true),
      model("codex", "codex-personal", "gpt"),
      model("codex", "codex-old", "gpt"),
    ],
    [
      account("codex-team", "codex", { five_hour: { usedPercent: 100, resetsAt: 7 } }, "exhausted"),
      account("codex-personal", "codex", { five_hour: { usedPercent: 30, resetsAt: 7 } }),
      account("codex-old", "codex", {}, "logged_out"),
    ],
    0,
  );

  expect(choices.map((c) => c.accountId)).toEqual(["codex-team", "codex-personal"]);
  expect(choices[0]).toMatchObject({ exhausted: true, resetsAt: 7 });
  expect(defaultModelChoice(choices, "codex")?.accountId).toBe("codex-personal");
});

test("New thread lists each model once and defaults to an account with headroom", () => {
  const options = newThreadOptions(
    [model("claude", "claude-work", "opus", true), model("claude", "claude-personal", "opus")],
    [
      account(
        "claude-work",
        "claude",
        { five_hour: { usedPercent: 100, resetsAt: 1 } },
        "exhausted",
      ),
      account("claude-personal", "claude", { five_hour: { usedPercent: 38, resetsAt: 1 } }),
    ],
    [{ provider: "claude", state: "ready" }],
  );

  expect(options.models.map((m) => m.id)).toEqual(["opus"]);
  expect(options.accounts.map((a) => [a.label, a.usage, a.isDefault])).toEqual([
    ["work", "100% of 5-hour used", false],
    ["personal", "38% of 5-hour used", true],
  ]);
});

test("New thread offers only installed CLIs, each on its default model when the catalog has none", () => {
  const options = newThreadOptions(
    [model("claude", "claude-personal", "opus", true), model("cursor", "cursor", "auto", true)],
    [],
    [
      { provider: "claude", state: "not_installed" },
      { provider: "codex", state: "ready" },
      { provider: "opencode", state: "signed_out" },
      { provider: "cursor", state: "ready" },
      { provider: "antigravity", state: "not_installed" },
    ],
  );

  expect(options.models.map((m) => [m.label, m.fromCatalog])).toEqual([
    ["auto", true],
    ["Codex · Default", false],
    ["OpenCode · Default", false],
  ]);
});

test("a model choice reads as provider, lower-case account tag and model", () => {
  const [choice] = modelChoices(
    [model("claude", "claude-work", "Sonnet 4.5", true)],
    [account("claude-work", "claude", { five_hour: { usedPercent: 10, resetsAt: 5 } })],
    0,
  );
  if (!choice) throw new Error("expected a choice");

  expect(choiceLine({ ...choice, account: "Work" })).toBe("Claude Code · work · Sonnet 4.5");
  expect(choiceLine({ ...choice, account: "" })).toBe("Claude Code · Sonnet 4.5");
});

test("a thread's picker shows what it runs on, or the switch waiting for its next turn", () => {
  const choices = modelChoices(
    [
      model("claude", "claude-personal", "opus", true),
      model("claude", "claude-work", "opus", true),
      model("codex", "codex-team", "gpt-5"),
    ],
    [
      account("claude-personal", "claude", {}),
      account("claude-work", "claude", {}),
      account("codex-team", "codex", {}),
    ],
    0,
  );
  expect(
    currentModelChoice(choices, { provider: "claude", model: "opus", instanceId: "claude-work" })
      ?.id,
  ).toBe("claude-work:opus");
  expect(currentModelChoice(choices, { provider: "codex", model: "gpt-5" })?.id).toBe(
    "codex-team:gpt-5",
  );
  // A model the catalog no longer lists falls back to the provider's default.
  expect(currentModelChoice(choices, { provider: "claude", model: "retired" })?.provider).toBe(
    "claude",
  );
  const work = choices.find((choice) => choice.id === "claude-work:opus");
  expect(work && choiceSelection(work)).toEqual({
    provider: "claude",
    model: "opus",
    instanceId: "claude-work",
  });
});

test("a thread on a provider the catalog doesn't list never shows another provider's model", () => {
  const choices = modelChoices(
    [model("codex", "codex-team", "gpt-5", true)],
    [account("codex-team", "codex", {})],
    0,
  );

  expect(currentModelChoice(choices, { provider: "claude" })).toBeUndefined();
  expect(currentModelChoice(choices, { provider: "claude", model: "opus" })).toBeUndefined();
  expect(recordedChoice({ provider: "claude" })?.model).toBe("Claude Code · Default");
  expect(currentModelChoice(choices, { provider: "codex" })?.id).toBe("codex-team:gpt-5");
});

test("a thread's effort can change only where the provider takes it as a session option", () => {
  const [opus] = modelChoices(
    [
      CatalogModel.parse({
        ...model("claude", "claude-personal", "opus", true),
        reasoningEfforts: ["low", "medium", "high"],
        defaultEffort: "medium",
      }),
    ],
    [account("claude-personal", "claude", {})],
    0,
  );
  const sessionOptions = { sessionOptions: true, launchOptions: ["effort" as const] };

  expect(
    threadEffortControl({ choice: opus, capabilities: sessionOptions, current: "high" }),
  ).toEqual({
    efforts: ["low", "medium", "high"],
    current: "high",
    reported: true,
    reason: undefined,
  });
  // Nothing reported reads as the model's default, and says it wasn't reported.
  const inferred = threadEffortControl({
    choice: opus,
    capabilities: sessionOptions,
    current: undefined,
  });
  expect([inferred.current, inferred.reported]).toEqual(["medium", false]);
  expect(
    threadEffortControl({
      choice: opus,
      capabilities: { sessionOptions: false },
      current: undefined,
    }).reason,
  ).toBe("Claude Code sets effort only when a thread starts");
});

test("a model without effort levels says so instead of offering a choice", () => {
  const [plain] = modelChoices([model("codex", "codex-personal", "gpt-5")], [], 0);
  expect(
    threadEffortControl({
      choice: plain,
      capabilities: { sessionOptions: true, launchOptions: ["effort"] },
      current: undefined,
    }).reason,
  ).toBe("gpt-5 has no effort levels");
});

test("only a string effort in execution options counts", () => {
  expect(optionEffort({ effort: "high" })).toBe("high");
  expect(optionEffort({ effort: 3 })).toBeUndefined();
  expect(optionEffort(undefined)).toBeUndefined();
});

test("effort levels read as words people use, whatever the provider calls them", () => {
  expect(["low", "medium", "high", "xhigh", "minimal"].map(effortLabel)).toEqual([
    "Low",
    "Medium",
    "High",
    "Extra high",
    "Minimal",
  ]);
  expect(effortLabel("very_deep")).toBe("Very deep");
});

test("offline, a thread's model reads from its own record, claiming no account or usage", () => {
  expect(recordedChoice({ provider: "claude", model: "claude-opus-4-1" })).toMatchObject({
    provider: "claude",
    model: "Opus 4.1",
    account: "",
    used: undefined,
  });
  expect(recordedChoice({ provider: "claude" })?.model).toBe("Claude Code · Default");
  expect(recordedChoice(undefined)).toBeUndefined();
});
