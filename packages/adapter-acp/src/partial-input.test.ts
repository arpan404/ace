import { antigravityQuirks } from "./index.ts";
import { it, expect } from "vitest";
import { harness, required } from "./test-helper.ts";
const malformed = [
  { label: "null", value: null },
  { label: "array", value: [] },
  { label: "number", value: 23 },
];
it.each(malformed)(
  "keeps valid input and native name after malformed input $label",
  ({ value: rawInput }) => {
    const h = harness();
    h.ready();
    h.update({
      sessionUpdate: "tool_call",
      toolCallId: "read",
      kind: "read",
      rawInput: { path: "/actual", futureInput: "essential-custom", _toolName: "native-read" },
      status: "in_progress",
    });
    h.update({ sessionUpdate: "tool_call_update", toolCallId: "read", rawInput });
    const live = JSON.stringify(required(h.tools()[0]).call.raw);
    expect(live).toContain('"rawInput":' + JSON.stringify(rawInput));
    expect(live).toContain('"path":"/actual"');
    h.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "read",
      status: "completed",
      rawOutput: { content: "done" },
    });
    const tool = required(h.tools()[0]);
    expect(tool.call.detail).toMatchObject({ kind: "file.read", path: "/actual" });
    expect(JSON.stringify(tool.call.raw)).toContain('"futureInput":"essential-custom"');
    expect(tool.call.raw.some((raw) => raw.name === "native-read")).toBe(true);
  },
);
it("keeps unknown initial tool metadata in later live and completed snapshots", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "read",
    kind: "read",
    rawInput: {},
    futureInitial: "original-only-metadata",
  });
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "read",
    rawInput: { path: "/actual" },
  });
  expect(JSON.stringify(required(h.tools()[0]).call.raw)).toContain(
    '"futureInitial":"original-only-metadata"',
  );
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "read", status: "completed" });
  expect(JSON.stringify(required(h.tools()[0]).call.raw)).toContain(
    '"futureInitial":"original-only-metadata"',
  );
});
function streamed(count: number) {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "read",
    kind: "read",
    rawInput: { path: "/initial", _toolName: "read" },
    status: "in_progress",
  });
  let bytes = 0;
  for (let n = 0; n < count; n++) {
    const events = h.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "read",
      rawInput: { [`field${n}`]: "x".repeat(64) },
    });
    bytes += Buffer.byteLength(JSON.stringify(events));
    expect(JSON.stringify(required(h.tools()[0]).call.raw)).toContain(
      `"field${n}":"${"x".repeat(64)}"`,
    );
  }
  const events = h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "read",
    status: "completed",
  });
  bytes += Buffer.byteLength(JSON.stringify(events));
  const raw = JSON.stringify(required(h.tools()[0]).call.raw);
  for (let n = 0; n < count; n++) expect(raw).toContain(`"field${n}":"${"x".repeat(64)}"`);
  expect(raw).toContain('"path":"/initial"');
  return bytes;
}
it("partial input changes scale linearly while final snapshots preserve every input field", () => {
  const a = streamed(100);
  const b = streamed(200);
  const c = streamed(400);
  expect(b).toBeLessThan(a * 2.25);
  expect(c).toBeLessThan(b * 2.25);
});
it("completed MCP details include all streamed top-level native arguments", () => {
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
    rawInput: { secondArgument: "second" },
  });
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "mcp", status: "completed" });
  expect(required(h.tools()[0]).call.detail).toMatchObject({
    kind: "mcp",
    arguments: { firstArgument: "first", secondArgument: "second" },
  });
});
it.each(malformed)(
  "a malformed native name $label cannot replace the last valid Antigravity tool name",
  ({ value: name }) => {
    const h = harness(antigravityQuirks);
    h.ready();
    h.update({
      sessionUpdate: "tool_call",
      toolCallId: "read",
      name: "read_file",
      rawInput: { TargetFile: "/actual" },
    });
    h.update({ sessionUpdate: "tool_call_update", toolCallId: "read", name });
    h.update({ sessionUpdate: "tool_call_update", toolCallId: "read", status: "completed" });
    const tool = required(h.tools()[0]);
    expect(tool.call.detail).toMatchObject({ kind: "file.read", path: "/actual" });
    expect(tool.call.raw.some((raw) => raw.name === "read_file")).toBe(true);
  },
);
it("MCP permission placeholders retain their original arguments through streamed input and completion", () => {
  const h = harness(antigravityQuirks);
  h.ready();
  h.frame("recv", {
    id: 100,
    method: "session/request_permission",
    params: {
      sessionId: "root-session",
      toolCall: { toolCallId: "mcp", name: "call_mcp_tool", rawInput: { firstArgument: "first" } },
      options: [{ optionId: "a", name: "Allow", kind: "allow_once" }],
    },
  });
  h.frame("send", { id: 100, result: { outcome: { outcome: "selected", optionId: "a" } } });
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "mcp",
    rawInput: { secondArgument: "second" },
  });
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "mcp", status: "completed" });
  expect(required(h.tools()[0]).call.detail).toMatchObject({
    kind: "mcp",
    arguments: { firstArgument: "first", secondArgument: "second" },
  });
});
