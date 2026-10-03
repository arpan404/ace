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

const sessionExtension = {
  id: "session-future",
  type: "boolean",
  currentValue: true,
  metadata: { description: "session extension", apiKey: "private-value" },
};
const sessionEffort = {
  id: "reasoning_effort",
  type: "select",
  currentValue: "high",
  options: [{ value: "high", name: "High" }],
};

test("empty per-model configs preserve session extensions without inheriting session semantics", () => {
  const perModel = { id: "model-future", type: "range", currentValue: 3 };
  const rows = normalizeAcp(
    {
      configOptions: [
        {
          ...model,
          options: [
            { value: "a", name: "A", configOptions: [] },
            { value: "b", name: "B", configOptions: [perModel] },
          ],
        },
        sessionExtension,
        sessionEffort,
      ],
    },
    instance("acp"),
  );
  expect(rows.map((row) => [row.id, row.isDefault])).toEqual([
    ["a", true],
    ["b", false],
  ]);
  for (const row of rows) {
    expect(row.reasoningEfforts).toEqual([]);
    expect(row.defaultEffort).toBeUndefined();
    expect(row.raw.truncated).toBe(false);
  }
  expect(JSON.parse(rows[0]?.raw.json ?? "null")).toMatchObject({
    configOptions: [],
    sessionConfigOptions: [
      { ...sessionExtension, metadata: { description: "session extension", apiKey: "[redacted]" } },
    ],
  });
  expect(JSON.parse(rows[1]?.raw.json ?? "null")).toMatchObject({ configOptions: [perModel] });
  expect(rows[1]?.raw.json).not.toContain("session extension");
});

test("session extensions have a deterministic representative when the current model is absent", () => {
  const perModel = { id: "model-future", type: "range", currentValue: 3 };
  const rows = normalizeAcp(
    {
      configOptions: [
        {
          ...model,
          currentValue: "missing",
          options: [
            { value: "a", name: "A", configOptions: [perModel] },
            { value: "b", name: "B" },
          ],
        },
        sessionExtension,
        sessionEffort,
      ],
    },
    instance("acp"),
  );
  expect(rows.map((row) => [row.id, row.isDefault])).toEqual([
    ["a", false],
    ["b", false],
  ]);
  expect(JSON.parse(rows[0]?.raw.json ?? "null")).toMatchObject({
    configOptions: [perModel],
    sessionConfigOptions: [
      { id: "session-future", currentValue: true, metadata: { apiKey: "[redacted]" } },
    ],
  });
  expect(rows[1]?.raw.json).not.toContain("session extension");
  for (const row of rows) {
    expect(row.reasoningEfforts).toEqual([]);
    expect(row.defaultEffort).toBeUndefined();
  }
});

test("session extensions choose the current row even when it is not the first model", () => {
  const rows = normalizeAcp(
    {
      configOptions: [
        {
          ...model,
          currentValue: "b",
          options: [
            { value: "a", name: "A", configOptions: [] },
            { value: "b", name: "B", configOptions: [] },
          ],
        },
        sessionExtension,
      ],
    },
    instance("acp"),
  );
  expect(rows.map((row) => [row.id, row.isDefault])).toEqual([
    ["a", false],
    ["b", true],
  ]);
  expect(rows[0]?.raw.json).not.toContain("session extension");
  expect(JSON.parse(rows[1]?.raw.json ?? "null")).toMatchObject({
    sessionConfigOptions: [{ id: "session-future", currentValue: true }],
  });
});

test("representative session metadata remains redacted and capped when per-model configs are empty", () => {
  const rows = normalizeAcp(
    {
      configOptions: [
        { ...model, options: [{ value: "a", name: "A", configOptions: [] }] },
        { ...sessionExtension, extra: "x".repeat(4096) },
      ],
    },
    instance("acp"),
  );
  expect(rows[0]).toMatchObject({ id: "a", isDefault: true, reasoningEfforts: [] });
  expect(rows[0]?.raw.truncated).toBe(true);
  expect(Buffer.byteLength(rows[0]?.raw.json ?? "")).toBeLessThanOrEqual(2048);
  expect(rows[0]?.raw.json).toContain('"apiKey":"[redacted]"');
  expect(rows[0]?.raw.json).not.toContain("private-value");
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
    await catalog.updateFromSession(instance("acp"), payload);
    payload = { configOptions: [model, invalid] };
    await expect(catalog.updateFromSession(instance("acp"), payload)).rejects.toThrow();
    expect(catalog.list().models.map((row) => row.id)).toEqual(["a", "b"]);
  } finally {
    await catalog.close();
  }
});
