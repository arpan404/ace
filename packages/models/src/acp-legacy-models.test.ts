import { expect, test } from "vitest";
import { ModelInstance, normalizeAcp } from "./index.ts";

const agent = (acpAgentId: string, installationVersion?: string) =>
  ModelInstance.parse({
    id: "agent",
    provider: "acp",
    acpAgentId,
    ...(installationVersion ? { installationVersion } : {}),
    loginRevision: "login",
    executable: "/never-executed",
    cwd: "/repo",
  });
const legacy = (availableModels: unknown[], currentModelId = "alpha") => ({
  models: { availableModels, currentModelId },
});

test.each([
  ["an unprofiled agent", agent("local:custom")],
  ["a profile without a legacy dialect", agent("official:qwen-code", "0.24.7")],
])("%s lists its legacy models, chosen through session/set_model", (_, instance) => {
  const rows = normalizeAcp(
    legacy([
      { modelId: "alpha", name: "Alpha Model" },
      { modelId: "beta", name: "Beta Model" },
    ]),
    instance,
  );
  expect(rows.map((row) => [row.id, row.displayName, row.selectorMethod, row.isDefault])).toEqual([
    ["alpha", "Alpha Model", "session/set_model", true],
    ["beta", "Beta Model", "session/set_model", false],
  ]);
});

test("a malformed legacy model list lists the well-formed models and never throws", () => {
  const rows = normalizeAcp(
    legacy([
      null,
      "bare",
      { name: "no id" },
      { modelId: 5, name: "numeric" },
      { modelId: "alpha", name: 12, configOptions: "not a list" },
      { modelId: "alpha", name: "Duplicate" },
    ]),
    agent("local:custom"),
  );
  expect(rows.map((row) => [row.id, row.displayName])).toEqual([["alpha", "Alpha"]]);
});

test("an oversized legacy model list gives an unprofiled agent no models instead of failing", () => {
  const many = Array.from({ length: 513 }, (_, index) => ({ modelId: `m${index}`, name: "M" }));
  expect(normalizeAcp(legacy(many, "m0"), agent("local:custom"))).toEqual([]);
});

test("model names lose control and bidi characters, and ids carrying them are never listed", () => {
  const legacyRows = normalizeAcp(
    legacy([
      { modelId: "alpha", name: "Al‮pha\u0000 Pro⁦" },
      { modelId: "spoof‮gpj", name: "Spoof" },
    ]),
    agent("local:custom"),
  );
  expect(legacyRows.map((row) => [row.id, row.displayName])).toEqual([["alpha", "Alpha Pro"]]);
  const configRows = normalizeAcp(
    {
      configOptions: [
        {
          id: "picker",
          category: "model",
          type: "select",
          currentValue: "one",
          options: [
            { value: "one", name: "One‏\u0007" },
            { value: "two⁧", name: "Two" },
          ],
        },
      ],
    },
    agent("local:custom"),
  );
  expect(configRows.map((row) => [row.id, row.displayName])).toEqual([["one", "One"]]);
});
