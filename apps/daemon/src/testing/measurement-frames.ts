import type { ProviderKind } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
type NativeFrame = Pick<Frame, "channel" | "dir" | "data">;
const frame = (data: unknown, channel = "stdio", dir: Frame["dir"] = "recv"): NativeFrame => ({
  data,
  channel,
  dir,
});

export function measurementFrames(
  provider: ProviderKind,
  args: unknown,
  tool = "screen_measure_interaction",
) {
  const rpc = (method: string, params: unknown) => frame({ method, params });
  const codexItem = {
    id: "measure",
    type: "mcpToolCall",
    server: "ace",
    tool,
    arguments: args,
    status: "inProgress",
  };
  if (provider === "codex")
    return {
      before: [
        rpc("thread/started", { thread: { id: "native", cwd: "/fixture" } }),
        rpc("turn/started", { threadId: "native", turn: { id: "turn" } }),
        rpc("item/started", { threadId: "native", turnId: "turn", item: codexItem }),
      ],
      after: [
        rpc("item/completed", {
          threadId: "native",
          turnId: "turn",
          item: { ...codexItem, status: "completed", result: "$RESULT" },
        }),
        rpc("turn/completed", { threadId: "native", turn: { id: "turn", status: "completed" } }),
      ],
    };
  if (provider === "claude")
    return {
      before: [
        frame({ type: "system", subtype: "init", session_id: "native", cwd: "/fixture" }, "sdk"),
        frame(
          {
            type: "assistant",
            message: {
              id: "message",
              content: [
                { type: "tool_use", id: "measure", name: `mcp__ace__${tool}`, input: args },
              ],
            },
          },
          "sdk",
        ),
      ],
      after: [
        frame(
          {
            type: "user",
            message: {
              content: [{ type: "tool_result", tool_use_id: "measure", content: "$RESULT" }],
            },
          },
          "sdk",
        ),
        frame({ type: "result", is_error: false, terminal_reason: "completed" }, "sdk"),
      ],
    };
  if (provider === "pi")
    return {
      before: [
        frame({ type: "agent_start" }),
        frame({ type: "tool_execution_start", toolCallId: "measure", toolName: tool, args }),
      ],
      after: [
        frame({
          type: "tool_execution_end",
          toolCallId: "measure",
          result: "$RESULT",
          isError: false,
        }),
        frame({ type: "agent_settled" }),
      ],
    };
  if (provider === "opencode") {
    let id = 0;
    const event = (type: string, data: unknown) =>
      frame({ id: `event-${++id}`, type, data, location: { directory: "/fixture" } }, "sse");
    return {
      before: [
        frame({ type: "started" }, "lifecycle", "note"),
        event("session.created", {
          sessionID: "native",
          projectID: "p",
          location: { directory: "/fixture" },
        }),
        event("session.execution.started", { sessionID: "native" }),
        event("session.tool.called", {
          sessionID: "native",
          assistantMessageID: "message",
          id: "measure",
          name: `ace_${tool}`,
          input: args,
        }),
      ],
      after: [
        event("session.tool.success", {
          sessionID: "native",
          assistantMessageID: "message",
          id: "measure",
          content: "$RESULT",
        }),
        event("session.execution.succeeded", { sessionID: "native" }),
      ],
    };
  }
  if (provider === "cursor") {
    const sdk = (kind: string, body: unknown) =>
      frame(
        {
          schemaVersion: 1,
          generation: "host",
          operationId: "operation",
          segment: 0,
          agentId: "native-root",
          kind,
          body,
        },
        "sdk",
      );
    return {
      before: [
        sdk("open", { cwd: "/fixture", deltaSource: true }),
        sdk("send", { input: [] }),
        sdk("delta", {
          type: "tool-call-started",
          callId: "measure",
          toolCall: { type: "mcp", args: { server: "ace", tool, arguments: args } },
        }),
      ],
      after: [
        sdk("delta", {
          type: "tool-call-completed",
          callId: "measure",
          toolCall: { type: "mcp", result: { status: "success", value: "$RESULT" } },
        }),
        sdk("result", { status: "finished" }),
      ],
    };
  }
  const update = (value: unknown) => rpc("session/update", { sessionId: "native", update: value });
  return {
    before: [
      frame({ id: 1, method: "session/new", params: { cwd: "/fixture" } }, "stdio", "send"),
      frame({ id: 1, result: { sessionId: "native" } }),
      frame(
        { id: 2, method: "session/prompt", params: { sessionId: "native", prompt: [] } },
        "stdio",
        "send",
      ),
      update({
        sessionUpdate: "tool_call",
        toolCallId: "measure",
        title: tool,
        kind: "other",
        status: "in_progress",
        rawInput: args,
      }),
    ],
    after: [
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "measure",
        status: "completed",
        rawOutput: "$RESULT",
      }),
      frame({ id: 2, result: { stopReason: "end_turn" } }),
    ],
  };
}
