import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readLogs } from "./runtime.ts";
import { scrubber, writeReport } from "./report.ts";

test("current and rotated daemon warnings fail a completed smoke report and are scrubbed", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-smoke-logs-"));
  try {
    await mkdir(join(home, "logs"));
    const token = "a".repeat(64);
    await writeFile(
      join(home, "logs/ace.jsonl"),
      JSON.stringify({ level: "error", message: `current token=${token}` }) + "\n",
    );
    await writeFile(
      join(home, "logs/ace.1.jsonl"),
      JSON.stringify({ level: "warn", message: "rotated warning" }) + "\n",
    );
    await writeFile(
      join(home, "logs/ace.2.jsonl"),
      [
        { level: "warn", message: "allowed", data: { code: "no_models", source: "Copilot" } },
        { level: "warn", message: "other provider", data: { code: "no_models", source: "Other" } },
        {
          level: "error",
          message: "Copilot error",
          data: { code: "no_models", source: "Copilot" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const findings = await readLogs(home);
    expect(findings).toHaveLength(4);
    expect(findings.map((finding) => finding.message)).toContain(`error: current token=${token}`);
    expect(findings.map((finding) => finding.message)).toContain("warn: rotated warning");
    await writeReport(
      home,
      {
        mode: "real",
        sha: "fixture",
        failures: findings.map(({ code, message }) => ({
          code,
          message,
          step: "shutdown",
          screenshot: "",
        })),
        steps: [],
        timings: {},
        copied: [],
        threadsVisited: 0,
        completed: true,
      },
      scrubber(token),
    );
    expect(await readFile(join(home, "summary.md"), "utf8")).toContain("Result: FAIL");
    expect(await readFile(join(home, "report.json"), "utf8")).not.toContain(token);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
