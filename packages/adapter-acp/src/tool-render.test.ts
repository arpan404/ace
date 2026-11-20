import { expect, it } from "vitest";
import { harness, required } from "./test-helper.ts";
import { antigravityQuirks } from "./quirks/antigravity.ts";
import { genericQuirks } from "./quirks/generic.ts";

// Shapes taken from Antigravity's real session/update frames.
it("an Antigravity MCP call shows its arguments once, not wrapped in `arguments`", () => {
  const h = harness(antigravityQuirks);
  h.ready();
  const meta = { mcp: { tool: "context", server: "ace" }, is_mcp_tool_call: true };
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "mcp",
    kind: "other",
    status: "pending",
    title: "ace_context",
    rawInput: { arguments: { topics: ["status"] } },
    _meta: meta,
  });
  expect(required(h.tools()[0]).call.detail).toEqual(
    expect.objectContaining({
      kind: "mcp",
      server: "ace",
      tool: "context",
      arguments: { topics: ["status"] },
    }),
  );
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "mcp",
    status: "completed",
    rawOutput: "Fetch project context",
  });
  const tool = required(h.tools()[0]);
  expect(tool.call.status).toBe("succeeded");
  expect(tool.call.detail).toMatchObject({ arguments: { topics: ["status"] } });
  expect(tool.call.error).toBeUndefined();
});

it("a failed Antigravity shell keeps the agent's failure text and its command", () => {
  const h = harness(antigravityQuirks);
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "find",
    kind: "execute",
    status: "in_progress",
    title: "find /outside -name notes",
    rawInput: { command_line: "find /outside -name notes", working_dir: "/workspace" },
  });
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "find",
    status: "failed",
    rawOutput: 'Access to path "/outside/notes" is denied. It is outside the allowed workspace.',
  });
  const tool = required(h.tools()[0]);
  expect(tool.call).toMatchObject({
    status: "failed",
    error: 'Access to path "/outside/notes" is denied. It is outside the allowed workspace.',
    detail: { kind: "shell", command: "find /outside -name notes", cwd: "/workspace" },
  });
});

it("a tool that completes with an error object shows that error", () => {
  const h = harness(genericQuirks);
  h.ready();
  h.update({ sessionUpdate: "tool_call", toolCallId: "t", kind: "fetch", status: "in_progress" });
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "t",
    status: "completed",
    rawOutput: { error: { message: "connection refused" } },
  });
  expect(required(h.tools()[0]).call).toMatchObject({
    status: "failed",
    error: "connection refused",
  });
});

it("a finished Antigravity file read is titled with the file it read, not 'Running view_file'", () => {
  const h = harness(antigravityQuirks);
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "read",
    title: "Running view_file",
    kind: "read",
    status: "in_progress",
    locations: [{ path: "/workspace/notes.txt" }],
    rawInput: { file_path: "/workspace/notes.txt", start_line: 0, end_line: 199 },
  });
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "read",
    status: "completed",
    rawOutput: "View notes",
  });
  expect(required(h.tools()[0]).call).toMatchObject({
    status: "succeeded",
    title: "Read /workspace/notes.txt",
    detail: { kind: "file.read", path: "/workspace/notes.txt" },
  });
});

it("a person's attached files, links and audio stay visible in their message", () => {
  const h = harness(genericQuirks);
  h.frame("send", { id: 1, method: "session/new", params: { cwd: "/workspace" } });
  h.frame("recv", { id: 1, result: { sessionId: "root-session" } });
  h.frame("send", {
    id: 2,
    method: "session/prompt",
    params: {
      sessionId: "root-session",
      prompt: [
        { type: "text", text: "Look at these" },
        {
          type: "resource",
          resource: { uri: "file:///workspace/a.md", mimeType: "text/markdown", text: "# A" },
        },
        { type: "resource_link", uri: "https://example.com/spec", name: "spec" },
        { type: "image", data: "iVBORw0KGgo=" },
        { type: "audio", data: "AAAA", mimeType: "audio/wav" },
      ],
    },
  });
  const message = Object.values(h.state.items).find(
    (item) => item.type === "message" && item.role === "user",
  );
  if (message?.type !== "message") throw new Error("Expected the person's message");
  expect(message.parts).toEqual([
    { type: "text", text: "Look at these" },
    { type: "file", path: "/workspace/a.md", mimeType: "text/markdown" },
    { type: "text", text: "https://example.com/spec" },
    { type: "image", mimeType: "image/png", url: "data:image/png;base64,iVBORw0KGgo=" },
    { type: "text", text: "[audio audio/wav]" },
  ]);
});
