import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { createCursorAdapter } from "@ace/adapter-cursor";
import { recordApprovedCursorSdkBatch } from "./record-cursor-sdk.ts";

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
