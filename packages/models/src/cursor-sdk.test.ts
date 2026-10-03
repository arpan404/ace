import { expect, it } from "vitest";
import { ModelInstance, normalizeCursorSdk } from "./index.ts";

it("keeps SDK-authenticated model parameters separate from guessed ACP defaults", () => {
  const instance = ModelInstance.parse({
    id: "sdk-a",
    provider: "cursor",
    backend: "cursor-sdk",
    homeDir: "/instances/a",
    cwd: "/workspace",
    loginRevision: "login-1",
  });
  const rows = normalizeCursorSdk(
    [
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        parameters: [{ id: "reasoning_effort", values: [{ value: "high", displayName: "High" }] }],
        variants: [
          {
            displayName: "High effort",
            isDefault: true,
            params: [{ id: "reasoning_effort", value: "high" }],
          },
        ],
        future: { setting: "retained", apiKey: "sentinel-key" },
      },
    ],
    instance,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    instance: "sdk-a",
    id: "composer-2.5",
    reasoningEfforts: ["high"],
    defaultTier: "0",
    serviceTiers: [{ parameters: { reasoning_effort: "high" } }],
  });
  expect(rows[0]?.raw.json).toContain("retained");
  expect(rows[0]?.raw.json).not.toContain("sentinel-key");
  expect(rows[0]?.contextWindow).toBeUndefined();
  expect(rows[0]?.defaultEffort).toBeUndefined();
});
