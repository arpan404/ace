import { describe, expect, test } from "vitest";
import { WorkspaceId, type OutsideScope } from "@ace/protocol";
import {
  missingScope,
  normalScopes,
  projectAllowed,
  shorthandScopes,
  withheldTools,
} from "./scopes.ts";

const read: OutsideScope[] = ["threads:read"];
const every: OutsideScope[] = [
  "threads:read",
  "threads:start",
  "threads:message",
  "threads:stop",
  "browser",
  "computer",
];

describe("each outside tool call needs exactly its scope from the ADR table", () => {
  const cases: [tool: string, args: unknown, scope: OutsideScope][] = [
    ["ace_projects_list", {}, "threads:read"],
    ["ace_models_list", {}, "threads:read"],
    ["ace_threads_list", {}, "threads:read"],
    ["ace_thread_read", {}, "threads:read"],
    ["ace_thread_status", {}, "threads:read"],
    ["ace_thread_run", {}, "threads:start"],
    ["ace_thread_send", {}, "threads:message"],
    ["ace_thread_stop", {}, "threads:stop"],
    ["ace_task_control", { operation: { op: "task.status" } }, "threads:read"],
    ["ace_task_control", { operation: { op: "task.spawn" } }, "threads:start"],
    ["ace_task_control", { operation: { op: "task.cancel" } }, "threads:stop"],
    ["browser_open", {}, "browser"],
    ["browser_act", {}, "browser"],
    ["screen_state", {}, "computer"],
    ["screen_act", {}, "computer"],
    // Provider spellings of a name reach the same rule.
    ["mcp__ace__thread_run", {}, "threads:start"],
  ];
  test.each(cases)("%s %j needs %s", (tool, args, scope) => {
    expect(missingScope([], tool, args)).toBe(scope);
    expect(missingScope([scope], tool, args)).toBeUndefined();
    // Every other scope together still doesn't cover it.
    expect(
      missingScope(
        every.filter((each) => each !== scope),
        tool,
        args,
      ),
    ).toBe(scope);
  });
});

test("a task operation the table doesn't know needs the start scope", () => {
  expect(missingScope(read, "ace_task_control", { operation: { op: "task.delete" } })).toBe(
    "threads:start",
  );
  expect(missingScope(read, "ace_task_control", "not an object")).toBe("threads:start");
});

test("a read grant is offered only the read tools", () => {
  const tools = [
    "ace_threads_list",
    "ace_thread_run",
    "ace_thread_send",
    "ace_thread_stop",
    "ace_task_control",
    "browser_open",
    "screen_act",
    "ace_notify",
  ];
  expect(withheldTools(read, tools)).toEqual([
    "thread_run",
    "thread_send",
    "thread_stop",
    "browser_open",
    "screen_act",
    // A tool outside the table is never offered, whatever the grant holds.
    "notify",
  ]);
  expect(withheldTools(every, tools)).toEqual(["notify"]);
});

test("the old enroll scopes map onto the split ones", () => {
  expect(shorthandScopes("read")).toEqual(["threads:read"]);
  expect(shorthandScopes("operate")).toEqual([
    "threads:read",
    "threads:start",
    "threads:message",
    "threads:stop",
  ]);
});

test("read is always part of a grant, and scopes keep the table's order", () => {
  expect(normalScopes(["computer", "browser", "computer"])).toEqual([
    "threads:read",
    "browser",
    "computer",
  ]);
});

test("a project limit admits only its projects", () => {
  const a = WorkspaceId.parse("a");
  const b = WorkspaceId.parse("b");
  expect(projectAllowed("all", a)).toBe(true);
  expect(projectAllowed([a], a)).toBe(true);
  expect(projectAllowed([a], b)).toBe(false);
});
