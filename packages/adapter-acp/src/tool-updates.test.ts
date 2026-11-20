import { expect, it } from "vitest";
import { harness, required } from "./test-helper.ts";
import { antigravityQuirks } from "./quirks/antigravity.ts";
import { genericQuirks } from "./quirks/generic.ts";

it("an MCP call is named by its MCP metadata, not by look-alike input fields", () => {
  const h = harness(genericQuirks);
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "m",
    status: "pending",
    title: "lookup",
    rawInput: { providerIdentifier: "evil", toolName: "wipe", query: "q" },
    _meta: { mcp: { server: "docs", tool: "lookup" } },
  });
  expect(required(h.tools()[0]).call.detail).toMatchObject({
    kind: "mcp",
    server: "docs",
    tool: "lookup",
    arguments: { providerIdentifier: "evil", toolName: "wipe", query: "q" },
  });
});

it("an MCP parameter named `arguments` keeps its sibling parameters, live and once finished", () => {
  const h = harness(genericQuirks);
  h.ready();
  const input = { arguments: { a: 1 }, query: "q" };
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "m",
    status: "pending",
    title: "lookup",
    rawInput: input,
    _meta: { mcp: { server: "docs", tool: "lookup" } },
  });
  expect(required(h.tools()[0]).call.detail).toMatchObject({ arguments: input });
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "m", status: "completed" });
  expect(required(h.tools()[0]).call.detail).toMatchObject({ arguments: input });
});

it("an embedded resource with text or bytes shows them with its file", () => {
  const h = harness(genericQuirks);
  h.ready();
  h.update({
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "resource",
      resource: { uri: "file:///workspace/notes.md", mimeType: "text/markdown", text: "# Notes" },
    },
  });
  h.update({
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "resource",
      resource: {
        uri: "file:///workspace/a.bin",
        mimeType: "application/octet-stream",
        blob: "AAE=",
      },
    },
  });
  const parts = Object.values(h.state.items).flatMap((item) =>
    item.type === "message" && item.role === "assistant" ? item.parts : [],
  );
  expect(parts).toEqual([
    {
      type: "file",
      path: "/workspace/notes.md",
      mimeType: "text/markdown",
      content: { encoding: "text", data: "# Notes" },
    },
    {
      type: "file",
      path: "/workspace/a.bin",
      mimeType: "application/octet-stream",
      content: { encoding: "base64", data: "AAE=" },
    },
  ]);
});

it("a failure's text that arrives in a later failed update reaches the row", () => {
  const h = harness(genericQuirks);
  h.ready();
  h.update({ sessionUpdate: "tool_call", toolCallId: "f", kind: "read", status: "in_progress" });
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "f", status: "failed" });
  expect(required(h.tools()[0]).call.error).toBeUndefined();
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "f",
    status: "failed",
    rawOutput: { error: "No such file" },
  });
  expect(required(h.tools()[0]).call).toMatchObject({ status: "failed", error: "No such file" });
});

it("stdout and stderr snapshots each keep growing the shell's output", () => {
  const h = harness(genericQuirks);
  h.ready();
  const shell = (rawOutput: unknown) =>
    h.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "s",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "make" },
      rawOutput,
    });
  shell({ stdout: "a", stderr: "!" });
  shell({ stdout: "ab", stderr: "!" });
  shell({ stdout: "ab", stderr: "!?" });
  shell({ stdout: "ab", stderr: "!?" });
  expect(required(h.tools()[0]).call.detail).toMatchObject({ output: { tail: "a!b?" } });
});

it("a generated title shows a path's line breaks and direction controls as escapes", () => {
  const h = harness(genericQuirks);
  h.ready();
  const path = "/workspace/a\nRead /etc/‮passwd";
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "r",
    kind: "read",
    status: "in_progress",
    rawInput: { path },
  });
  const call = required(h.tools()[0]).call;
  expect(call.title).toBe("Read /workspace/a\\u{a}Read /etc/\\u{202e}passwd");
  expect(call.detail).toMatchObject({ kind: "file.read", path });
});

it("an Antigravity tool is known by its native name before its display title", () => {
  const h = harness(antigravityQuirks);
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "v",
    status: "in_progress",
    title: "run_command",
    rawInput: { _toolName: "view_file", path: "/workspace/x" },
  });
  expect(required(h.tools()[0]).call.kind).toBe("file.read");
});

it("a plan from an agent with no plan tool is its own todo row, revised in place", () => {
  const h = harness(genericQuirks);
  h.ready();
  const plan = (status: string) =>
    h.update({
      sessionUpdate: "plan",
      entries: [
        { content: "Read the code", priority: "high", status },
        { content: "Fix it", priority: "medium", status: "pending" },
      ],
    });
  plan("in_progress");
  plan("completed");
  const rows = h.tools();
  expect(rows).toHaveLength(1);
  expect(required(rows[0]).call).toMatchObject({
    kind: "todo",
    detail: {
      kind: "todo",
      todos: [
        { content: "Read the code", status: "completed" },
        { content: "Fix it", status: "pending" },
      ],
    },
  });
});
