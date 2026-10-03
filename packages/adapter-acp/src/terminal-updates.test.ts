import { expect, it } from "vitest";
import { antigravityQuirks } from "./index.ts";
import { end, harness, required } from "./test-helper.ts";

function mcp() {
  const h = harness(antigravityQuirks);
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "mcp",
    name: "call_mcp_tool",
    rawInput: { firstArgument: "first" },
    status: "in_progress",
  });
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "mcp",
    rawInput: { middleArgument: "middle" },
  });
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "mcp",
    rawInput: { lastArgument: "last" },
  });
  return h;
}
function expectArguments(h: ReturnType<typeof harness>) {
  const tool = required(h.tools()[0]);
  expect(tool.call.detail).toMatchObject({
    kind: "mcp",
    arguments: {
      firstArgument: "first",
      middleArgument: "middle",
      lastArgument: "last",
    },
  });
  const raw = JSON.stringify(tool.call.raw);
  for (const value of ["first", "middle", "last"]) expect(raw).toContain(`"${value}"`);
}
it("MCP completion keeps all arguments after output-only and duplicate terminal refreshes", () => {
  const h = mcp();
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "mcp", status: "completed" });
  end(h);
  for (const update of [
    { rawOutput: { content: "later output" } },
    { status: "completed", future: 1 },
  ]) {
    const events = h.update({ sessionUpdate: "tool_call_update", toolCallId: "mcp", ...update });
    expectArguments(h);
    expect(JSON.stringify(events)).toContain(JSON.stringify(update).slice(1, -1));
    expect(h.state.status.state).toBe("done");
  }
});
it.each(["cancelled", "end_turn"])(
  "synthetic %s preserves the full MCP input and arguments",
  (reason) => {
    const h = mcp();
    end(h, reason);
    expect(required(h.tools()[0]).call.status).toBe("cancelled");
    expectArguments(h);
    h.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "mcp",
      rawOutput: { content: "late" },
    });
    expectArguments(h);
  },
);
it("a reopened MCP tool keeps collected arguments through live metadata and renewed completion", () => {
  const h = mcp();
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "mcp", status: "completed" });
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "mcp", status: "in_progress" });
  expect(required(h.tools()[0]).call.detail).toMatchObject({
    arguments: { firstArgument: "first", middleArgument: "middle", lastArgument: "last" },
  });
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "mcp", future: "live metadata" });
  expect(required(h.tools()[0]).call.detail).toMatchObject({
    arguments: { middleArgument: "middle" },
  });
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "mcp",
    rawInput: { newArgument: "new" },
    status: "completed",
  });
  expectArguments(h);
  expect(required(h.tools()[0]).call.detail).toMatchObject({ arguments: { newArgument: "new" } });
});
it("late MCP metadata changes publish typed tool identity without losing collected arguments", () => {
  const h = mcp();
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "mcp", status: "completed" });
  end(h);
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "mcp",
    _meta: { mcp: { server: "later-server", tool: "later-tool" } },
  });
  expect(required(h.tools()[0]).call.detail).toMatchObject({
    server: "later-server",
    tool: "later-tool",
  });
  expectArguments(h);
  expect(h.state.status.state).toBe("done");
});
it("permission denial assembles every streamed input field in the declined snapshot", () => {
  const h = mcp();
  h.frame("recv", {
    id: 100,
    method: "session/request_permission",
    params: {
      sessionId: "root-session",
      toolCall: { toolCallId: "mcp" },
      options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
    },
  });
  h.frame("send", { id: 100, result: { outcome: { outcome: "selected", optionId: "deny" } } });
  expect(required(h.tools()[0]).call.status).toBe("declined");
  expectArguments(h);
  end(h);
  expectArguments(h);
});

function completedRefreshBytes(fields: number) {
  const h = harness(antigravityQuirks);
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "mcp",
    name: "call_mcp_tool",
    status: "in_progress",
  });
  for (let n = 0; n < fields; n++)
    h.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "mcp",
      rawInput: { [`field${n}`]: "x".repeat(64) },
    });
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "mcp", status: "completed" });
  end(h);
  let bytes = 0;
  for (let n = 0; n < 100; n++) {
    const events = h.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "mcp",
      status: "completed",
      rawOutput: { content: "late" },
      future: "latest",
    });
    bytes += Buffer.byteLength(JSON.stringify(events));
    bytes += Buffer.byteLength(JSON.stringify(h.translated()));
    expect(JSON.stringify(events)).toContain('"future":"latest"');
  }
  const tool = required(h.tools()[0]);
  const raw = JSON.stringify(tool.call.raw);
  const detail = tool.call.detail;
  if (detail.kind !== "mcp") throw new Error("Expected an MCP call");
  for (let n = 0; n < fields; n++) {
    expect(raw).toContain(`"field${n}":"${"x".repeat(64)}"`);
    expect(detail.arguments).toHaveProperty(`field${n}`, "x".repeat(64));
  }
  expect(h.state.status.state).toBe("done");
  return bytes;
}
it("late metadata event bytes are independent of completed input history size", () => {
  const small = completedRefreshBytes(100);
  const medium = completedRefreshBytes(200);
  const large = completedRefreshBytes(400);
  expect(medium).toBeLessThan(small * 1.25);
  expect(large).toBeLessThan(small * 1.25);
});

function shellRefreshBytes(length: number) {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "shell",
    kind: "execute",
    rawInput: { command: "synthetic shell" },
    status: "in_progress",
  });
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "shell",
    rawOutput: { stdout: "x".repeat(length) },
  });
  let bytes = 0;
  for (let n = 0; n < 100; n++) {
    const events = h.update({ sessionUpdate: "tool_call_update", toolCallId: "shell", future: n });
    bytes += Buffer.byteLength(JSON.stringify(events));
    bytes += Buffer.byteLength(JSON.stringify(h.translated()));
    expect(events.some((event) => event.type === "item.delta" && event.field === "output")).toBe(
      false,
    );
  }
  const tool = required(h.tools()[0]);
  expect(tool.call.detail).toMatchObject({ kind: "shell", output: { bytes: length } });
  const events = h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "shell",
    rawOutput: { stdout: "x".repeat(length) + "suffix" },
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "item.delta",
      itemId: tool.id,
      field: "output",
      append: "suffix",
    }),
  );
  expect(required(h.tools()[0]).call.detail).toMatchObject({ output: { bytes: length + 6 } });
  return bytes;
}
it("shell metadata refreshes do not republish cumulative output and later output emits only its suffix", () => {
  const small = shellRefreshBytes(8192);
  const large = shellRefreshBytes(32768);
  expect(large).toBeLessThan(small * 1.25);
});
it("late Cursor extension requests preserve assembled terminal input without resending it", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "read",
    kind: "read",
    status: "in_progress",
    rawInput: { path: "/actual", first: "first" },
  });
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "read",
    rawInput: { middle: "middle" },
  });
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "read",
    rawInput: { last: "last" },
    status: "completed",
  });
  end(h);
  const events = h.frame("recv", {
    id: 101,
    method: "cursor/future",
    params: {
      sessionId: "root-session",
      toolCallId: "read",
      future: "extension-metadata",
    },
  });
  const raw = JSON.stringify(required(h.tools()[0]).call.raw);
  for (const value of ["first", "middle", "last"]) expect(raw).toContain(`"${value}"`);
  expect(JSON.stringify(events)).toContain("extension-metadata");
  expect(JSON.stringify(events)).not.toContain('"middle":"middle"');
  expect(h.state.status.state).toBe("done");
});
it("native cancellation still settles a synthetically cancelled uncertain shell with the same status", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "shell",
    kind: "execute",
    status: "in_progress",
  });
  end(h, "cancelled");
  expect(h.state.status).toMatchObject({ state: "waiting", on: "background_task" });
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "shell", status: "cancelled" });
  expect(h.state.status.state).toBe("done");
  expect(Object.values(h.state.tasks)).toContainEqual(
    expect.objectContaining({ status: "stopped" }),
  );
});
it("a long shell prefix correction is retained as raw instead of silently accepted as an append", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "shell",
    kind: "execute",
    status: "in_progress",
  });
  const tail = "t".repeat(8192);
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "shell",
    rawOutput: { stdout: "old" + tail },
  });
  const events = h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "shell",
    rawOutput: { stdout: "new" + tail },
  });
  expect(events.some((event) => event.type === "item.delta" && event.field === "output")).toBe(
    false,
  );
  expect(JSON.stringify(events)).toContain('"stdout":"new');
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "item.created",
      item: expect.objectContaining({
        type: "notice",
        text: "Shell output replaced earlier text; the replacement is retained in raw data.",
      }),
    }),
  );
  expect(required(h.tools()[0]).call.detail).toMatchObject({ output: { bytes: 8195 } });
});
