import { expect, it } from "vitest";
import {
  buildTriageFacts,
  digestLogLines,
  triageLaunchLine,
  triagePlaybook,
  type TriageFacts,
} from "@ace/diagnostics/triage";

const now = 1_800_000_000_000;
const line = (at: number, level: string, message: string, data?: unknown) =>
  JSON.stringify({ at, level, component: "ace", message, ...(data ? { data } : {}) });
const facts = (overrides: Partial<TriageFacts> = {}): TriageFacts => ({
  collectedAt: "2027-01-15T08:00:00.000Z",
  cliVersion: "0.0.4",
  os: "darwin arm64",
  node: "v24.1.0",
  launchedFrom: "/Applications/ace.app/Contents/Resources/daemon/cli.js",
  daemon: "stopped",
  clis: [{ label: "Claude Code", version: "2.1.0" }, { label: "OpenCode" }],
  paths: {
    data: "~/.ace",
    log: "~/.ace/logs/ace.jsonl",
    settings: "~/.ace/settings.json",
    databases: ["~/.ace/events.sqlite"],
    sourceCache: "/tmp/ace-triage-source",
  },
  secrets: ["~/.ace/daemon-token", "~/.ace/tls"],
  logs: [],
  problems: [],
  now,
  ...overrides,
});

it("the facts file tells the agent what runs here, where everything is and what never to open", () => {
  const text = buildTriageFacts(
    facts({
      logs: [
        {
          level: "error",
          component: "engine",
          message: "Stop timed out",
          count: 3,
          lastAt: now - 300_000,
        },
      ],
    }),
  );
  expect(text).toContain("ace CLI version: 0.0.4");
  expect(text).toContain("ace daemon: stopped");
  expect(text).toContain("Agent CLIs: Claude Code 2.1.0, OpenCode");
  expect(text).toContain("~/.ace/logs/ace.jsonl");
  expect(text).toContain("~/.ace/events.sqlite");
  expect(text).toContain("Source cache (clone ace here): /tmp/ace-triage-source");
  expect(text).toContain("Never open: ~/.ace/daemon-token, ~/.ace/tls");
  expect(text).toContain("- 3× error engine: Stop timed out (last 5m ago)");
  expect(text).not.toContain("Couldn't check");
});

it("a broken install's failed probes and doctor findings are listed, and a quiet log says so", () => {
  const broken = facts({
    clis: [],
    problems: ["Reading ~/.ace/logs/ace.jsonl failed: EACCES"],
    findings: [{ id: "sqlite", status: "fail", message: "Integrity check failed" }],
  });
  delete broken.daemon;
  const text = buildTriageFacts(broken);
  expect(text).toContain("ace daemon: unknown");
  expect(text).toContain("Agent CLIs: none found");
  expect(text).toContain("## Couldn't check\n\n- Reading ~/.ace/logs/ace.jsonl failed: EACCES");
  expect(text).toContain("- FAIL sqlite: Integrity check failed");
  expect(text).toContain("## Recent warnings and errors (last 24 hours)\n\nNone.");
});

it("the agent is launched with one line that points at a playbook which points at the facts", () => {
  const launch = triageLaunchLine("/tmp/t/PLAYBOOK.md");
  expect(launch).not.toContain("\n");
  expect(launch).toContain("/tmp/t/PLAYBOOK.md");
  expect(triagePlaybook("/tmp/t/FACTS.md")).toContain("/tmp/t/FACTS.md");
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
