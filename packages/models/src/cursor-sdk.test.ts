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
    efforts: [{ id: "high", level: "high", label: "High" }],
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
    efforts: [{ id: "high", level: "high", label: "High" }],
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
    efforts: [],
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
      efforts: [
        { id: "low", level: "low", label: "Low" },
        { id: "high", level: "high", label: "High" },
      ],
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

const params = (context: string, reasoning: string, fast: string) => [
  { id: "context", value: context },
  { id: "reasoning", value: reasoning },
  { id: "fast", value: fast },
];

it("only sends Cursor parameter combinations the SDK lists, at standard context", () => {
  const instance = ModelInstance.parse({
    id: "sdk-a",
    provider: "cursor",
    backend: "cursor-sdk",
    homeDir: "/instances/a",
    cwd: "/workspace",
    loginRevision: "login-1",
  });
  // GPT-5.5's real listing: fast exists only at 272k, and the default variant is 1m.
  const [row] = normalizeCursorSdk(
    [
      {
        id: "gpt-5.5",
        parameters: [
          { id: "context", values: [{ value: "272k" }, { value: "1m" }] },
          { id: "reasoning", values: [{ value: "medium" }, { value: "high" }] },
          { id: "fast", values: [{ value: "false" }, { value: "true" }] },
        ],
        variants: [
          { displayName: "GPT-5.5", params: params("272k", "medium", "false") },
          { displayName: "GPT-5.5 Fast", params: params("272k", "medium", "true") },
          { displayName: "GPT-5.5 High", params: params("272k", "high", "false") },
          { displayName: "GPT-5.5 High Fast", params: params("272k", "high", "true") },
          { displayName: "GPT-5.5 1M", isDefault: true, params: params("1m", "medium", "false") },
          { displayName: "GPT-5.5 1M High", params: params("1m", "high", "false") },
        ],
      },
    ],
    instance,
  );
  if (!row) throw new Error("Missing normalized model");
  expect(cursorModelParams(row, {})).toEqual(params("272k", "medium", "false"));
  expect(cursorModelParams(row, { effort: "high", serviceTier: "fast" })).toEqual(
    params("272k", "high", "true"),
  );
});

const values = (...list: string[]) => list.map((value) => ({ value }));

it("every effort and speed of a 40-variant Cursor model resolves to a listed standard-context variant", () => {
  const instance = ModelInstance.parse({
    id: "sdk-a",
    provider: "cursor",
    backend: "cursor-sdk",
    homeDir: "/instances/a",
    cwd: "/workspace",
    loginRevision: "login-1",
  });
  // Claude Opus 4.8's real listing: thinking × context × effort × fast, default at 1m.
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  const variants = ["false", "true"].flatMap((thinking) =>
    ["300k", "1m"].flatMap((context) =>
      efforts.flatMap((effort) =>
        ["false", "true"].map((fast) => ({
          displayName: "Claude Opus 4.8",
          isDefault:
            thinking === "true" && context === "1m" && effort === "high" && fast === "false",
          params: [
            { id: "cyber", value: "false" },
            { id: "thinking", value: thinking },
            { id: "context", value: context },
            { id: "effort", value: effort },
            { id: "fast", value: fast },
          ],
        })),
      ),
    ),
  );
  const [row] = normalizeCursorSdk(
    [
      {
        id: "claude-opus-4-8",
        displayName: "Claude Opus 4.8",
        parameters: [
          { id: "thinking", values: values("false", "true") },
          { id: "context", values: values("300k", "1m") },
          { id: "effort", values: values(...efforts) },
          { id: "fast", values: values("false", "true") },
        ],
        variants,
      },
    ],
    instance,
  );
  if (!row) throw new Error("Claude Opus 4.8 must stay in the catalog");
  expect(row.efforts.map((effort) => effort.id)).toEqual(efforts);
  const listed = new Set(variants.map((variant) => JSON.stringify(variant.params)));
  for (const effort of [undefined, ...efforts])
    for (const serviceTier of [undefined, "fast", "default"]) {
      const sent = cursorModelParams(row, {
        ...(effort ? { effort } : {}),
        ...(serviceTier ? { serviceTier } : {}),
      });
      expect(listed.has(JSON.stringify(sent))).toBe(true);
      expect(sent).toContainEqual({ id: "context", value: "300k" });
      expect(sent).toContainEqual({ id: "thinking", value: "true" });
      if (effort) expect(sent).toContainEqual({ id: "effort", value: effort });
      if (serviceTier)
        expect(sent).toContainEqual({
          id: "fast",
          value: serviceTier === "fast" ? "true" : "false",
        });
    }
});
