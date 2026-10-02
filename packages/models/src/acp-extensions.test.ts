import { expect, test } from "vitest";
import { ModelCatalog, normalizeAcp } from "./index.ts";
import { Clock, instance } from "./testing/support.ts";

const model = {
  id: "model",
  type: "select",
  currentValue: "a",
  options: [
    { value: "a", name: "A" },
    { value: "b", name: "B" },
  ],
};

test("unknown ACP option semantics preserve models and bounded redacted raw metadata", () => {
  const future = {
    id: "reasoning_effort",
    type: "boolean",
    currentValue: true,
    options: { enabled: true },
    metadata: { description: "future setting", apiKey: "private-value" },
  };
  const rows = normalizeAcp({ configOptions: [model, future] }, instance("acp"));
  expect(rows.map((row) => [row.id, row.isDefault])).toEqual([
    ["a", true],
    ["b", false],
  ]);
  expect(rows[0]?.reasoningEfforts).toEqual([]);
  expect(rows[0]?.defaultEffort).toBeUndefined();
  expect(rows[0]?.raw.truncated).toBe(false);
  expect(JSON.parse(rows[0]?.raw.json ?? "null")).toMatchObject({
    configOptions: [model, { ...future, metadata: { ...future.metadata, apiKey: "[redacted]" } }],
  });
  expect(rows[1]?.raw.json).not.toContain("future setting");
  const large = normalizeAcp(
    { configOptions: [model, { ...future, extra: "x".repeat(4096) }] },
    instance("acp"),
  );
  expect(large[0]?.raw.truncated).toBe(true);
  expect(Buffer.byteLength(large[0]?.raw.json ?? "")).toBeLessThanOrEqual(2048);
});

test("unknown model option types fall back to legacy model rows and preserve their metadata", () => {
  const future = { id: "model", type: "future", currentValue: false, options: [1, 2] };
  const rows = normalizeAcp(
    {
      configOptions: [future],
      models: {
        currentModelId: "legacy",
        availableModels: [{ modelId: "legacy", name: "Legacy" }],
      },
    },
    instance("acp"),
  );
  expect(rows.map((row) => [row.id, row.isDefault])).toEqual([["legacy", true]]);
  expect(JSON.parse(rows[0]?.raw.json ?? "null")).toMatchObject({ configOptions: [future] });
});

test("per-model unknown options do not affect known select effort choices", () => {
  const rows = normalizeAcp(
    {
      configOptions: [
        {
          ...model,
          options: [
            {
              value: "a",
              name: "A",
              configOptions: [
                { id: "future", type: "range", currentValue: 3, options: { min: 0, max: 5 } },
                {
                  id: "reasoning_effort",
                  type: "select",
                  currentValue: "high",
                  options: [{ value: "high", name: "High" }],
                },
              ],
            },
          ],
        },
      ],
    },
    instance("acp"),
  );
  expect(rows[0]).toMatchObject({ id: "a", reasoningEfforts: ["high"], defaultEffort: "high" });
  expect(rows[0]?.raw.json).toContain('"currentValue":3');
});

test.each([
  { id: "future", type: "select", currentValue: true },
  { id: "reasoning_effort", type: "select", options: [true] },
])("malformed known select data keeps the last valid ACP picker rows: %j", async (invalid) => {
  const clock = new Clock();
  let payload: unknown = { configOptions: [model] };
  const catalog = new ModelCatalog({
    storage: { load: () => [], replace() {}, remove() {}, close() {} },
    instances: [instance("acp")],
    discover: async (config) => normalizeAcp(payload, config),
    now: () => clock.now,
    deadline: clock.deadline,
  });
  try {
    await catalog.refresh();
    payload = { configOptions: [model, invalid] };
    expect(await catalog.refresh()).toMatchObject([{ error: "discovery_failed" }]);
    expect(catalog.list().models.map((row) => row.id)).toEqual(["a", "b"]);
  } finally {
    await catalog.close();
  }
});
