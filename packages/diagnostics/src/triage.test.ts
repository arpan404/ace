import { expect, it } from "vitest";
import { buildTriagePrompt, digestLogLines } from "@ace/diagnostics/triage";

const now = 1_800_000_000_000;
const line = (at: number, level: string, message: string, data?: unknown) =>
  JSON.stringify({ at, level, component: "ace", message, ...(data ? { data } : {}) });

it("a performance handoff preserves the description and distinguishes measurements from provider latency", () => {
  const prompt = buildTriagePrompt({
    kind: "performance",
    description: "Switching threads takes 4 seconds",
    report: {
      at: 123,
      checks: [{ id: "git", status: "fail", message: "Git missing", fix: "Install Git" }],
    },
  });
  expect(prompt).toContain("Switching threads takes 4 seconds");
  expect(prompt).toContain("measure the slow path");
  expect(prompt).toContain("provider or network latency");
  expect(prompt).toContain("Git missing");
  expect(prompt).toContain("Install Git");
  expect(prompt).toContain("publishing anything");
});

it("a feature handoff asks for acceptance criteria and does not use the bug investigation workflow", () => {
  const prompt = buildTriagePrompt({
    kind: "feature",
    description: "Add grouped notifications",
    followUp: "Grouped by thread, newest first",
  });
  expect(prompt).toContain("acceptance criteria");
  expect(prompt).toContain("Add grouped notifications");
  expect(prompt).toContain("## Done when\nGrouped by thread, newest first");
  expect(prompt).not.toContain("Reproduce");
  expect(() => buildTriagePrompt({ kind: "bug", description: "  " })).toThrow();
});

it("a bug handoff tells the agent what is installed, whether the daemon runs and where the logs are", () => {
  const prompt = buildTriagePrompt({
    kind: "bug",
    description: "Stop leaves the thread working",
    followUp: "It should stop within a second",
    context: {
      daemon: "running",
      clis: [{ label: "Claude Code", version: "2.1.0" }, { label: "OpenCode" }],
      dataDir: "~/.ace",
      logFile: "~/.ace/logs/ace.jsonl",
      now,
      logs: [
        {
          level: "error",
          component: "engine",
          message: "Stop timed out",
          count: 3,
          lastAt: now - 5 * 60_000,
        },
      ],
    },
  });
  expect(prompt).toContain("## Expected\nIt should stop within a second");
  expect(prompt).toContain("3× error engine: Stop timed out (last 5m ago)");
  expect(prompt).toContain("ace daemon: running");
  expect(prompt).toContain("Agent CLIs: Claude Code 2.1.0, OpenCode");
  expect(prompt).toContain("~/.ace/logs/ace.jsonl");
  expect(prompt).toContain("never write to them");
});

it("a setup handoff needs no description, summarizes passed checks and omits raw diagnostic JSON", () => {
  const prompt = buildTriagePrompt({
    kind: "doctor",
    description: "",
    report: {
      at: 123,
      checks: [
        { id: "node", status: "ok", message: "Node v24.0.0", fix: "" },
        {
          id: "sqlite.space",
          status: "warn",
          message: "12 MiB reusable",
          fix: "Run ace doctor --fix",
        },
      ],
    },
  });
  expect(prompt).toContain("12 MiB reusable");
  expect(prompt).toContain("Run ace doctor --fix");
  expect(prompt).toContain("1 check passed");
  expect(prompt).not.toContain("Node v24.0.0");
  expect(prompt).not.toContain('"checks":');
  expect(prompt).not.toContain("## Notes");
});

it("recent log warnings are grouped by message with errors first, skipping old, info and malformed lines", () => {
  const digest = digestLogLines(
    [
      line(now - 60_000, "warn", "WebSocket closed", { code: 1006 }),
      line(now - 30_000, "warn", "WebSocket closed", { code: 1001 }),
      line(now - 50_000, "warn", "WebSocket closed"),
      line(now - 120_000, "error", "Engine stalled", { ms: 15_000 }),
      line(now - 2 * 86_400_000, "error", "Ancient failure"),
      line(now - 1_000, "info", "Started"),
      '{"at":1,"level":',
      "not json at all",
    ],
    { now },
  );
  expect(digest).toEqual([
    expect.objectContaining({ level: "error", message: "Engine stalled", count: 1 }),
    expect.objectContaining({
      level: "warn",
      message: "WebSocket closed",
      count: 3,
      lastAt: now - 30_000,
      sample: '{"code":1001}',
    }),
  ]);
});
