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
/** An `ace_thread_start` call as OpenCode reports it: ace's answer only in the raw snapshot. */
function call(status: "succeeded" | "failed", answer: unknown, tool = "ace_thread_start") {
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
      detail: { kind: "mcp", server: "ace", tool, arguments: args },
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
  });
});

test("Claude's prefixed tool name is read as the same thread start, with the answer's account", () => {
  expect(
    startedThreadOf(
      call(
        "succeeded",
        { ok: true, data: { threadId: "dc12", title: "Renamed", account: "360" } },
        "mcp__ace__ace_thread_start",
      ),
    ),
  ).toMatchObject({ threadId: "dc12", title: "Renamed", account: "360" });
});

test("a refused or failed start names no thread to open", () => {
  expect(startedThreadOf(call("succeeded", { ok: false, code: "forbidden" }))).toBeUndefined();
  expect(startedThreadOf(call("failed", { ok: true, data: { threadId: "x" } }))).toBeUndefined();
});
