import { cursorModelParams } from "@ace/provider-kit/cursor-selection";
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
  expect(rows[0]?.defaultEffort).toBe("high");
});

it("accepts the full SDK catalog including empty native parameter values and nullable extensions", async () => {
  const { cursorSdkModels } = await import("./testing/cursor-sdk-fixture.ts");
  const instance = ModelInstance.parse({
    id: "sdk-a",
    provider: "cursor",
    backend: "cursor-sdk",
    homeDir: "/instances/a",
    cwd: "/workspace",
    loginRevision: "login-1",
  });
  const rows = normalizeCursorSdk(cursorSdkModels, instance);
  expect(rows.map((row) => row.id)).toEqual(["composer-2.5", "minimal", "nullable"]);
  expect(rows[0]).toMatchObject({
    aliases: ["composer"],
    reasoningEfforts: ["high"],
    defaultTier: "0",
    serviceTiers: [
      { parameters: { reasoning_effort: "", speed: "" } },
      { parameters: { reasoning_effort: "high" } },
    ],
  });
  expect(rows[0]?.raw.json).toContain("new-enum-value");
  expect(rows[0]?.raw.json).not.toContain("sentinel-key");
  expect(rows[2]?.displayName).toBe("Nullable");
});

it("keeps healthy SDK models when one entry has no usable model identity", async () => {
  const { cursorSdkMixedModels } = await import("./testing/cursor-sdk-fixture.ts");
  const instance = ModelInstance.parse({
    id: "sdk-a",
    provider: "cursor",
    backend: "cursor-sdk",
    homeDir: "/instances/a",
    cwd: "/workspace",
    loginRevision: "login-1",
  });
  const rows = normalizeCursorSdk(cursorSdkMixedModels, instance);
  expect(rows.map((row) => row.id)).toEqual(["composer-2.5", "minimal", "nullable"]);
});

it("retains optional metadata as raw data when it cannot be used for controls", () => {
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
        id: "usable",
        parameters: [{ id: "future", values: null }],
        variants: [{ displayName: null, params: "future-format" }],
        aliases: [null],
      },
    ],
    instance,
  );
  expect(rows[0]).toMatchObject({
    id: "usable",
    displayName: "Usable",
    serviceTiers: [],
    reasoningEfforts: [],
  });
  expect(rows[0]?.raw.json).toContain("future-format");
});

it("reports bounded rejection reasons without vendor text and refuses wholly unreadable lists", () => {
  const instance = ModelInstance.parse({
    id: "sdk-a",
    provider: "cursor",
    backend: "cursor-sdk",
    homeDir: "/instances/a",
    cwd: "/workspace",
    loginRevision: "login-1",
  });
  const rejected: { index: number; reason: string }[] = [];
  expect(() =>
    normalizeCursorSdk(
      [{ id: "private-vendor-value".repeat(100), displayName: "private-name" }, null],
      instance,
      (entry) => rejected.push(entry),
    ),
  ).toThrow("no readable model entries");
  expect(rejected.map((entry) => entry.index)).toEqual([0, 1]);
  expect(rejected.every((entry) => entry.reason.length <= 200)).toBe(true);
  expect(JSON.stringify(rejected)).not.toContain("private");
  expect(() => normalizeCursorSdk({ items: [] }, instance)).toThrow();
  expect(() =>
    normalizeCursorSdk(
      Array.from({ length: 513 }, () => ({ id: "model" })),
      instance,
    ),
  ).toThrow();
});

it("isolates a model that exceeds normalized row limits from healthy models", () => {
  const instance = ModelInstance.parse({
    id: "sdk-a",
    provider: "cursor",
    backend: "cursor-sdk",
    homeDir: "/instances/a",
    cwd: "/workspace",
    loginRevision: "login-1",
  });
  const rejected: { index: number; reason: string }[] = [];
  const rows = normalizeCursorSdk(
    [
      {
        id: "oversized",
        variants: Array.from({ length: 32 }, (_variant, index) => ({
          displayName: `Variant ${index}`,
          params: Array.from({ length: 16 }, (_parameter, parameter) => ({
            id: `parameter-${parameter}`,
            value: "x".repeat(256),
          })),
        })),
      },
      { id: "healthy", displayName: "Healthy" },
    ],
    instance,
    (entry) => rejected.push(entry),
  );
  expect(rows.map((row) => row.id)).toEqual(["healthy"]);
  expect(rejected).toEqual([
    { index: 0, reason: "Normalized model exceeds catalog field or row limits." },
  ]);
});

it.each(["effort", "reasoning", "reasoning_effort"])(
  "exposes account-reported %s and fast parameters without guessing SDK keys",
  (key) => {
    const instance = ModelInstance.parse({
      id: "sdk-a",
      provider: "cursor",
      backend: "cursor-sdk",
      homeDir: "/instances/a",
      cwd: "/workspace",
      loginRevision: "login-1",
    });
    const [row] = normalizeCursorSdk(
      [
        {
          id: "native",
          parameters: [
            { id: key, values: [{ value: "low" }, { value: "high" }] },
            { id: "fast", values: [{ value: "false" }, { value: "true" }] },
          ],
          variants: [
            {
              displayName: "Default",
              isDefault: true,
              params: [
                { id: key, value: "high" },
                { id: "context", value: "300k" },
                { id: "fast", value: "false" },
              ],
            },
          ],
        },
      ],
      instance,
    );
    expect(row).toMatchObject({
      reasoningEfforts: ["low", "high"],
      defaultEffort: "high",
      serviceTiers: expect.arrayContaining([
        expect.objectContaining({
          speed: "fast",
          parameters: { fast: "true", serviceTier: "fast" },
        }),
      ]),
    });
    if (!row) throw new Error("Missing normalized model");
    expect(cursorModelParams(row, { effort: "low", serviceTier: "fast" })).toEqual([
      { id: key, value: "low" },
      { id: "context", value: "300k" },
      { id: "fast", value: "true" },
    ]);
    expect(cursorModelParams(row, { serviceTier: "default" })).toContainEqual({
      id: "fast",
      value: "false",
    });
    expect(() => cursorModelParams(row, { effort: "max" })).toThrow("does not support");
  },
);
