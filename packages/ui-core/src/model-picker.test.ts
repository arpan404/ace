import { expect, test } from "vitest";
import { nextOptions, pickerModelsFromChoices, speedControl } from "./model-picker.ts";
import { modelKey, recordedChoice, type ModelChoice } from "./models.ts";

const choice = (patch: Partial<ModelChoice>): ModelChoice => {
  const base = recordedChoice({ provider: "codex", model: "gpt-5" });
  if (!base) throw new Error("no choice");
  return { ...base, key: modelKey("codex", "gpt-5"), model: "GPT-5", ...patch };
};

const limit = (resetsAt: number | undefined) => `resets ${resetsAt ?? "?"}`;

test("a model is unavailable only when every account serving it is at its limit", () => {
  const open = pickerModelsFromChoices(
    [choice({ id: "a", exhausted: true, resetsAt: 9 }), choice({ id: "b", exhausted: false })],
    limit,
  );
  expect(open).toMatchObject([{ label: "GPT-5", unavailable: undefined }]);

  const blocked = pickerModelsFromChoices(
    [
      choice({ id: "a", exhausted: true, resetsAt: 9 }),
      choice({ id: "b", exhausted: true, resetsAt: 4 }),
    ],
    limit,
  );
  expect(blocked).toMatchObject([{ unavailable: "resets 4" }]);
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
