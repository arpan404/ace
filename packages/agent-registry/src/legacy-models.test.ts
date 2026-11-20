import { expect, test } from "vitest";
import { listedModels, selectorRequest, sessionSelectors } from "./index.ts";

const legacy = (availableModels: unknown, currentModelId: unknown = "a") => ({
  models: { availableModels, currentModelId },
});

test("an unprofiled agent's legacy model list selects only ids the agent listed", () => {
  const selectors = sessionSelectors(legacy([{ modelId: "a", name: "A" }, { modelId: "b" }]));
  expect(selectorRequest(selectors, "model", "b", "s")).toEqual({
    method: "session/set_model",
    params: { sessionId: "s", modelId: "b" },
  });
  // A catalog-only or free-form value is never sent.
  expect(() => selectorRequest(selectors, "model", "catalog-only", "s")).toThrow("unavailable");
  expect(() => selectorRequest(selectors, "model", "", "s")).toThrow("unavailable");
});

test("a malformed legacy model list skips bad entries and never throws", () => {
  const listed = listedModels(
    legacy([
      null,
      7,
      "bare-string",
      { name: "no id" },
      { modelId: 42 },
      { modelId: "" },
      { modelId: "x".repeat(257) },
      { modelId: "good", name: { nested: true } },
      { modelId: "good", name: "Duplicate" },
      { modelId: "kept", name: "Kept", extra: [1, 2] },
    ]),
  );
  expect(listed?.models.map(({ modelId, name }) => [modelId, name])).toEqual([
    ["good", "good"],
    ["kept", "Kept"],
  ]);
  for (const raw of [null, "x", legacy("not a list"), legacy({}), { models: [] }])
    expect(() => sessionSelectors(raw)).not.toThrow();
  expect(sessionSelectors(legacy("not a list")).model).toBeUndefined();
  expect(sessionSelectors(legacy([null, { modelId: 3 }])).model).toBeUndefined();
});

test("an oversized legacy model list offers no picker, and the rest of the setup still reads", () => {
  const many = Array.from({ length: 513 }, (_, index) => ({ modelId: `m${index}`, name: "M" }));
  const selectors = sessionSelectors({
    ...legacy(many),
    modes: { availableModes: [{ id: "plan" }] },
  });
  expect(selectors.model).toBeUndefined();
  expect(selectors.mode?.values).toEqual(["plan"]);
});

test("model labels drop control and bidi characters, and ids carrying them are never offered", () => {
  const listed = listedModels(
    legacy([
      { modelId: "safe", name: "Na‮me\u0007​\n" },
      { modelId: "evil‮id", name: "Evil" },
      { modelId: "nul\u0000", name: "Nul" },
      { modelId: "blank", name: "⁦⁩" },
    ]),
  );
  expect(listed?.models.map(({ modelId, name }) => [modelId, name])).toEqual([
    ["safe", "Name"],
    ["blank", "blank"],
  ]);
  const config = sessionSelectors({
    configOptions: [
      {
        id: "picker",
        category: "model",
        type: "select",
        options: [
          { value: "ok", name: "Ok" },
          { value: "bad⁧", name: "Bad" },
        ],
      },
    ],
  });
  expect(config.model?.values).toEqual(["ok"]);
});

test("an agent that rejected session/set_model gets no legacy model picker for the session", () => {
  const setup = legacy([{ modelId: "a", name: "A" }]);
  expect(sessionSelectors(setup, undefined, false).model).toBeUndefined();
  // The standard config selector doesn't depend on the legacy setter.
  const config = {
    ...setup,
    configOptions: [
      { id: "m", category: "model", type: "select", options: [{ value: "c", name: "C" }] },
    ],
  };
  expect(sessionSelectors(config, undefined, false).model?.method).toBe(
    "session/set_config_option",
  );
});
