import { expect, test } from "vitest";
import { agentSubtree, filterLog, formatLog, readFilter } from "./log-filter.ts";
import type { LogLine } from "./thread-log.ts";

const line = (key: string, patch: Partial<LogLine>): LogLine => ({
  key,
  at: 0,
  source: "shell",
  level: "info",
  text: key,
  ...patch,
});

const log: LogLine[] = [
  line("created", { source: "daemon", text: "thread created in ace" }),
  line("session", { source: "session", agentId: "root", text: "claude-code session started" }),
  line("spawn", { source: "agent", agentId: "sweep", text: "subagent resume-sweep spawned" }),
  line("test", { agentId: "sweep", text: "$ bun run test outbox" }),
  line("fail", { agentId: "probe", level: "error", text: "bun run test outbox · exit 1" }),
  line("quota", { source: "notice", agentId: "root", level: "warn", text: "82% of the window" }),
];
const keys = (lines: readonly LogLine[]) => lines.map((each) => each.key);

test("an agent's log holds its own lines and its subagents', not the thread's or siblings'", () => {
  const agents = [
    { id: "probe", parentId: "sweep" },
    { id: "root", parentId: null },
    { id: "sweep", parentId: "root" },
    { id: "other", parentId: "root" },
  ];
  const sweep = agentSubtree(agents, "sweep");
  expect(keys(filterLog(log, { level: "all", hidden: [] }, "", sweep))).toEqual([
    "spawn",
    "test",
    "fail",
  ]);
});

test("a level shows that level and worse", () => {
  expect(keys(filterLog(log, { level: "warn", hidden: [] }, ""))).toEqual(["fail", "quota"]);
  expect(keys(filterLog(log, { level: "error", hidden: [] }, ""))).toEqual(["fail"]);
});

test("hidden sources drop out, and the text filter matches text or source, ignoring case", () => {
  expect(keys(filterLog(log, { level: "all", hidden: ["shell", "agent"] }, ""))).toEqual([
    "created",
    "session",
    "quota",
  ]);
  expect(keys(filterLog(log, { level: "all", hidden: [] }, "OUTBOX"))).toEqual(["test", "fail"]);
  expect(keys(filterLog(log, { level: "all", hidden: [] }, "notice"))).toEqual(["quota"]);
});

test("a stored filter that can't be read falls back to showing everything", () => {
  expect(readFilter({ level: "loud", hidden: ["shell", 4] })).toEqual({ level: "all", hidden: [] });
  expect(readFilter(undefined)).toEqual({ level: "all", hidden: [] });
  expect(readFilter({ level: "warn", hidden: ["turn"] })).toEqual({
    level: "warn",
    hidden: ["turn"],
  });
});

test("copied lines read as time, level or source, then text", () => {
  expect(formatLog(log.slice(3, 5), () => "12:04:31")).toBe(
    "12:04:31  shell    $ bun run test outbox\n12:04:31  error    bun run test outbox · exit 1",
  );
});
