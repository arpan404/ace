import { mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";
import { createCursorAdapter } from "@ace/adapter-cursor";
import {
  recordApprovedCursorSdkBatch,
  recordFullAccessCursorSdkBatch,
} from "./record-cursor-sdk.ts";

it("keeps a failed attempt and restricted skips durable and refuses another batch in the same fixture directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-sdk-batch-"));
  const output = join(root, "captures");
  let now = 100000,
    id = 0;
  const dependencies = {
    signal: new AbortController().signal,
    now: () => now,
    id: () => `fixture-${++id}`,
    launchEnv: { CURSOR_API_KEY: "sentinel-failure-secret" },
    modelCatalog: async () => [{ id: "composer-2.5" }],
    adapter: (options: Parameters<typeof createCursorAdapter>[0]) => ({
      ...createCursorAdapter(options),
      async openSession(): Promise<never> {
        now += 25;
        throw new Error("SDK provider refused sentinel-failure-secret");
      },
    }),
  };
  try {
    const results = await recordApprovedCursorSdkBatch(
      output,
      { id: "fixture", homeDir: root },
      dependencies,
    );
    expect(results.filter((result) => result.outcome === "skipped")).toHaveLength(14);
    expect(results.find((result) => result.scenario === "full-access")).toMatchObject({
      outcome: "incomplete",
      elapsedMs: 25,
    });
    const reportPath = join(output, "recording-report.json");
    const report = await readFile(reportPath, "utf8");
    expect(report).not.toContain("sentinel-failure-secret");
    const capturePath = join(output, "full-access.jsonl");
    const capture = await readFile(capturePath, "utf8");
    const rows = capture
      .trim()
      .split("\n")
      .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
    expect(rows.at(-1)).toMatchObject({
      type: "sdk-scenario-analysis",
      observations: { outcome: "incomplete" },
    });
    await expect(
      recordApprovedCursorSdkBatch(output, { id: "fixture", homeDir: root }, dependencies),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(reportPath, "utf8")).toBe(report);
    expect(await readFile(capturePath, "utf8")).toBe(capture);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("admits only the twelve skipped full-access behaviours once, retains the original run and moves on after failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-sdk-continuation-"));
  const fixture = fileURLToPath(
    new URL("../../../fixtures/cursor-sdk/1.0.35/composer-2.5/", import.meta.url),
  );
  const source = z
    .object({
      approval: z.string(),
      sdkVersion: z.literal("1.0.35"),
      model: z.literal("composer-2.5"),
      scenarioTimeCapMs: z.literal(180000),
      scenarios: z.array(z.unknown()),
      initialScenarios: z.array(z.unknown()).optional(),
    })
    .parse(JSON.parse(await readFile(join(fixture, "recording-report.json"), "utf8")));
  const initial = {
    approval: source.approval,
    sdkVersion: source.sdkVersion,
    model: source.model,
    scenarioTimeCapMs: source.scenarioTimeCapMs,
    scenarios: source.initialScenarios ?? source.scenarios,
  };
  await writeFile(join(root, "recording-report.json"), JSON.stringify(initial));
  await copyFile(join(fixture, "full-access.jsonl"), join(root, "full-access.jsonl"));
  const original = await readFile(join(root, "full-access.jsonl"), "utf8");
  let now = 100000,
    id = 0;
  const deps = {
    signal: new AbortController().signal,
    now: () => now,
    id: () => `fixture-${++id}`,
    launchEnv: { CURSOR_API_KEY: "continuation-secret" },
    modelCatalog: async () => [],
    adapter: (options: Parameters<typeof createCursorAdapter>[0]) => ({
      ...createCursorAdapter(options),
      async openSession(): Promise<never> {
        now += 25;
        throw new Error("Provider refused continuation-secret");
      },
    }),
  };
  try {
    const results = await recordFullAccessCursorSdkBatch(
      root,
      { id: "fixture", homeDir: root },
      deps,
    );
    expect(results.filter((value) => value.outcome === "incomplete")).toHaveLength(12);
    expect(
      results.filter((value) => value.outcome === "skipped").map((value) => value.scenario),
    ).toEqual(["restricted-mcp", "mcp-image"]);
    expect(results.find((value) => value.scenario === "full-access")).toMatchObject({
      outcome: "complete",
      elapsedMs: 10995,
    });
    const capture = await readFile(join(root, "usage.jsonl"), "utf8");
    expect(JSON.parse(capture.split("\n")[0] ?? "")).toMatchObject({
      recordingPolicy: "full-access",
      sandbox: false,
      autoReview: false,
    });
    const report = await readFile(join(root, "recording-report.json"), "utf8");
    expect(report).not.toContain("continuation-secret");
    await expect(
      recordFullAccessCursorSdkBatch(root, { id: "fixture", homeDir: root }, deps),
    ).rejects.toThrow("no retries");
    expect(await readFile(join(root, "recording-report.json"), "utf8")).toBe(report);
    expect(await readFile(join(root, "full-access.jsonl"), "utf8")).toBe(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
