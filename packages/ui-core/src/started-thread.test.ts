import { expect, test } from "vitest";
import { Item } from "@ace/protocol";
import { startedThreadOf } from "./started-thread.ts";

const args = {
  requestId: "separate-360-001",
  title: "Separate 360 chat",
  text: "Hello",
  provider: "codex",
  model: "gpt-6-luna",
  workspace: { kind: "project" },
};
/** A `thread_start` call as OpenCode reports it: ace's answer only in the raw snapshot. */
function call(
  status: "succeeded" | "failed",
  answer: unknown,
  tool = "thread_start",
  server = "ace",
) {
  return Item.parse({
    id: "call",
    agentId: "root",
    createdAt: 1,
    complete: true,
    type: "tool_call",
    call: {
      id: "call",
      agentId: "root",
      kind: "mcp",
      title: `ace_${tool}`,
      status,
      startedAt: 1,
      detail: { kind: "mcp", server, tool, arguments: args },
      raw: [
        {
          type: "snapshot.tool",
          data: { state: { content: [{ type: "text", text: JSON.stringify(answer) }] } },
        },
      ],
    },
  });
}

test("an answer that only carries the thread id still names the thread from the call", () => {
  expect(startedThreadOf(call("succeeded", { ok: true, data: { threadId: "dc12" } }))).toEqual({
    threadId: "dc12",
    title: "Separate 360 chat",
    provider: "codex",
    model: "gpt-6-luna",
    account: undefined,
    forked: false,
  });
});

test("Claude's prefixed tool name is read as the same thread start, with the answer's account", () => {
  expect(
    startedThreadOf(
      call(
        "succeeded",
        { ok: true, data: { threadId: "dc12", title: "Renamed", account: "360" } },
        "mcp__ace__thread_start",
        "unknown",
      ),
    ),
  ).toMatchObject({ threadId: "dc12", title: "Renamed", account: "360" });
});

test("another server's own thread_start opens no ace thread", () => {
  const answer = { ok: true, data: { threadId: "dc12" } };
  expect(startedThreadOf(call("succeeded", answer, "thread_start", "linear"))).toBeUndefined();
});

test("a refused or failed start names no thread to open", () => {
  expect(startedThreadOf(call("succeeded", { ok: false, code: "forbidden" }))).toBeUndefined();
  expect(startedThreadOf(call("failed", { ok: true, data: { threadId: "x" } }))).toBeUndefined();
});

/** Cursor and ACP agents reach thread_start only through ace's `tools_call`. */
function dispatched(name: string, answer: unknown) {
  return Item.parse({
    id: "call",
    agentId: "root",
    createdAt: 1,
    complete: true,
    type: "tool_call",
    call: {
      id: "call",
      agentId: "root",
      kind: "mcp",
      title: "tools_call",
      status: "succeeded",
      startedAt: 1,
      detail: {
        kind: "mcp",
        server: "ace",
        tool: "tools_call",
        arguments: { name, arguments: args },
      },
      raw: [],
      result: {
        isError: false,
        content: [{ type: "text", text: JSON.stringify(answer) }],
        structuredContent: answer,
        durationMs: 5,
      },
    },
  });
}

test("a thread started through tools_call opens the same card, named from the dispatched call", () => {
  expect(
    startedThreadOf(dispatched("thread_start", { ok: true, data: { threadId: "dc12" } })),
  ).toMatchObject({ threadId: "dc12", title: "Separate 360 chat", model: "gpt-6-luna" });
});

test("another tool called through tools_call opens no thread", () => {
  expect(
    startedThreadOf(dispatched("thread_read", { ok: true, data: { threadId: "dc12" } })),
  ).toBeUndefined();
});

test("a fork opens the same card, marked as a fork", () => {
  expect(
    startedThreadOf(
      call("succeeded", { ok: true, data: { threadId: "f1", title: "Try SQLite" } }, "thread_fork"),
    ),
  ).toMatchObject({ threadId: "f1", title: "Try SQLite", forked: true });
  expect(
    startedThreadOf(dispatched("thread_fork", { ok: true, data: { threadId: "f2" } })),
  ).toMatchObject({ threadId: "f2", forked: true });
});
