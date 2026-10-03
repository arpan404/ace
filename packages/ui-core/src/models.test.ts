import { CatalogModel, type ProviderKind } from "@ace/protocol";
import { AccountSummary } from "@ace/protocol/accounts";
import { expect, test } from "vitest";
import { accountView, blockingReset } from "./accounts.ts";
import { defaultModelChoice, modelChoices, newThreadOptions } from "./models.ts";

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
  expect(blockingReset(codex)).toBe(3);
});

test("each model is offered on the account that serves it, with that account's usage", () => {
  const choices = modelChoices(
    [model("claude", "claude-personal", "opus", true), model("claude", "claude-work", "opus")],
    [
      account("claude-personal", "claude", { five_hour: { usedPercent: 62, resetsAt: 5 } }),
      account("claude-work", "claude", { five_hour: { usedPercent: 23, resetsAt: 5 } }),
    ],
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
  );

  expect(options.models.map((m) => m.id)).toEqual(["opus"]);
  expect(options.accounts.map((a) => [a.label, a.usage, a.isDefault])).toEqual([
    ["work", "100% of 5-hour used", false],
    ["personal", "38% of 5-hour used", true],
  ]);
});

test("with no model catalog, New thread still offers each provider on its default model", () => {
  const options = newThreadOptions([], []);

  expect(options.models.map((m) => [m.label, m.fromCatalog])).toContainEqual([
    "Claude Code default",
    false,
  ]);
  expect(options.models.filter((m) => m.isDefault)).toHaveLength(1);
});
