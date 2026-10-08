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
  modelKey,
  newThreadOptions,
  selectNewThreadModel,
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
    id,
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

test("New thread keeps each account's own rows and defaults to an account with headroom", () => {
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

  expect(options.models.map((m) => [m.account, m.id, m.isDefault])).toEqual([
    ["claude-work", "opus", true],
    ["claude-personal", "opus", false],
  ]);
  expect(options.accounts.map((a) => [a.label, a.usage, a.isDefault])).toEqual([
    ["work", "100% of 5-hour used", false],
    ["personal", "38% of 5-hour used", true],
  ]);
});

test("New thread offers only installed CLIs and makes up no default model for an empty catalog", () => {
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

  expect(options.models.map((m) => [m.provider, m.label])).toEqual([["cursor", "auto"]]);
});

test("New thread picks the account first, then that account's own default", () => {
  const { models, accounts } = newThreadOptions(
    [
      model("codex", "codex-personal", "gpt-6.1-sol", true),
      model("codex", "codex-personal", "gpt-5"),
      model("codex", "codex-work", "gpt-6.1-sol"),
      model("codex", "codex-work", "gpt-5", true),
    ],
    [account("codex-personal", "codex", {}), account("codex-work", "codex", {})],
    [{ provider: "codex", state: "ready" }],
  );
  const pick = (remembered: string | undefined, key?: string) => {
    const picked = selectNewThreadModel({
      models,
      accounts,
      provider: "codex",
      model: key,
      account: remembered,
    });
    return [picked.account?.id, picked.model?.id];
  };

  expect(pick(undefined)).toEqual(["codex-personal", "gpt-6.1-sol"]);
  expect(pick("codex-work")).toEqual(["codex-work", "gpt-5"]);
  // A model the person picked stays picked on whichever account they choose.
  expect(pick("codex-work", modelKey("codex", "gpt-6.1-sol"))).toEqual([
    "codex-work",
    "gpt-6.1-sol",
  ]);
});

test("an account whose catalog lists nothing has no model rather than another account's", () => {
  const { models, accounts } = newThreadOptions(
    [model("claude", "claude-personal", "opus", true)],
    [account("claude-personal", "claude", {}), account("claude-work", "claude", {})],
    [{ provider: "claude", state: "ready" }],
  );
  const picked = selectNewThreadModel({
    models,
    accounts,
    provider: "claude",
    model: undefined,
    account: "claude-work",
  });

  expect(picked.account?.id).toBe("claude-work");
  expect(picked.model).toBeUndefined();
});

test("an OpenCode model switches by its qualified catalog id, not its bare native id", () => {
  const row = CatalogModel.parse({
    ...model("opencode", "opencode", "opencode-go/muse-spark-1.3-contributor", true),
    nativeProviderId: "opencode-go",
    nativeModelId: "muse-spark-1.3-contributor",
  });
  const choices = modelChoices([row], [account("opencode", "opencode", {})], 0);
  const current = currentModelChoice(choices, {
    provider: "opencode",
    model: "opencode-go/muse-spark-1.3-contributor",
  });

  expect(current && choiceSelection(current)).toEqual({
    provider: "opencode",
    model: "opencode-go/muse-spark-1.3-contributor",
    instanceId: "opencode",
  });
});

test("a model choice preserves the account name between its provider and model", () => {
  const [choice] = modelChoices(
    [model("claude", "claude-work", "Sonnet 4.5", true)],
    [account("claude-work", "claude", { five_hour: { usedPercent: 10, resetsAt: 5 } })],
    0,
  );
  if (!choice) throw new Error("expected a choice");

  expect(choiceLine({ ...choice, account: "Work" })).toBe("Claude Code · Work · Sonnet 4.5");
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
  expect(recordedChoice({ provider: "claude" })?.model).toBe("Unknown model");
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
  expect(recordedChoice({ provider: "claude" })?.model).toBe("Unknown model");
  expect(recordedChoice(undefined)).toBeUndefined();
});
