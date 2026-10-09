import { expect, test } from "vitest";
import { modelName } from "./model-label.ts";
import {
  modelControlName,
  nextOptions,
  pickerList,
  pickerModelsFromChoices,
  reconcileNextOptions,
  speedControl,
} from "./model-picker.ts";
import { modelKey, recordedChoice, type ModelChoice } from "./models.ts";

const choice = (patch: Partial<ModelChoice>): ModelChoice => {
  const base = recordedChoice({ provider: "codex", model: "gpt-5" });
  if (!base) throw new Error("no choice");
  return { ...base, key: modelKey("codex", "gpt-5"), model: "GPT-5", ...patch };
};

const limit = (resetsAt: number | undefined) => `resets ${resetsAt ?? "?"}`;

test("search keeps each account's model and its own limit state", () => {
  const rows = pickerModelsFromChoices(
    [
      choice({ id: "a", accountId: "a", exhausted: true, resetsAt: 9 }),
      choice({ id: "b", accountId: "b", exhausted: false }),
    ],
    limit,
  );
  expect(pickerList(rows, { query: "gpt", favorites: [], instance: "a" }).rows).toMatchObject([
    { label: "GPT-5", instance: "a", unavailable: "resets 9" },
    { label: "GPT-5", instance: "b", unavailable: undefined },
  ]);
  expect(
    pickerList(rows, { query: "", favorites: [rows[0]?.key ?? ""], instance: "a" }).rows,
  ).toMatchObject([{ label: "GPT-5", instance: "b", unavailable: undefined }]);
});

test("speed can change on a running thread only where the provider takes a service tier", () => {
  const model = { label: "GPT-5", provider: "codex" as const, fastTier: "priority" };
  expect(speedControl({ model, current: "priority" })).toEqual({
    tier: "priority",
    on: true,
    reason: undefined,
  });
  expect(
    speedControl({
      model,
      current: undefined,
      running: true,
      capabilities: { sessionOptions: true, launchOptions: ["effort"] },
    }).reason,
  ).toBe("Codex sets speed only when a thread starts");
  expect(
    speedControl({ model: { ...model, fastTier: undefined }, current: undefined }).reason,
  ).toBe("GPT-5 has no faster tier");
});

test("a change that lands back on what the thread runs with sends no options", () => {
  const base = { effort: "low", summary: "auto" };
  const raised = nextOptions(base, base, { effort: "high" });
  expect(raised).toEqual({ effort: "high", summary: "auto" });
  expect(nextOptions(base, raised ?? base, { effort: "low" })).toBeUndefined();
  expect(nextOptions(base, base, { effort: undefined })).toEqual({ summary: "auto" });
});

test("a model the catalog runs fast by default is fast until turned off explicitly", () => {
  const model = {
    label: "GPT-5",
    provider: "codex" as const,
    fastTier: "priority",
    fastDefault: true,
  };
  expect(speedControl({ model, current: undefined })).toMatchObject({ on: true, off: "default" });
  expect(speedControl({ model, current: "default" }).on).toBe(false);
  const standard = { ...model, fastDefault: false };
  expect(speedControl({ model: standard, current: undefined })).toMatchObject({
    on: false,
    off: undefined,
  });
});

test("after the thread moves, what the new model takes is kept and the rest is named", () => {
  const kept = reconcileNextOptions({
    base: {},
    pending: { effort: "high", serviceTier: "priority" },
    efforts: ["low", "medium", "high"],
    effortAllowed: true,
    fastTier: "priority",
    speedAllowed: true,
  });
  expect(kept).toEqual({ options: { effort: "high", serviceTier: "priority" }, dropped: [] });

  const moved = reconcileNextOptions({
    base: { summary: "auto" },
    pending: { effort: "minimal", serviceTier: "priority" },
    efforts: ["low", "medium", "high"],
    effortAllowed: true,
    fastTier: undefined,
    speedAllowed: true,
  });
  expect(moved).toEqual({ options: undefined, dropped: ["effort", "speed"] });
});

test("the model chip's tooltip names the provider once, the default included", () => {
  const details = { account: "personal", effort: "high", hasEfforts: true };
  expect(modelControlName({ model: "Opus 4.1", provider: "claude", ...details })).toBe(
    "Claude Code · Opus 4.1, personal, High effort",
  );
  expect(modelControlName({ model: modelName("claude"), provider: "claude", ...details })).toBe(
    "Claude Code · Default, personal, High effort",
  );
  // Its accessible name leaves the provider to the mark beside it.
  expect(modelControlName({ model: "Opus 4.1", ...details })).toBe(
    "Opus 4.1, personal, High effort",
  );
});

test("an opus alias favourite survives a catalog refresh and stays listed once", () => {
  const rows = pickerModelsFromChoices(
    [
      choice({
        provider: "claude",
        modelId: "claude-opus-5-5",
        model: "Opus 5.5",
        key: modelKey("claude", "claude-opus-5-5"),
        aliases: ["opus"],
        aliasKeys: [modelKey("claude", "opus")],
      }),
    ],
    limit,
  );
  expect(
    pickerList(rows, {
      query: "",
      favorites: [modelKey("claude", "opus"), modelKey("claude", "claude-opus-5-5")],
    }).rows.map((row) => row.label),
  ).toEqual(["Opus 5.5"]);
});
