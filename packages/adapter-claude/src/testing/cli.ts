#!/usr/bin/env node
// Synthetic provider boundary. No model, auth service, or installed CLI is invoked.
import { readPrivateMcpConfig } from "@ace/mcp-server";
import { list, object } from "../native.ts";
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  console.log("2.1.286 (Claude Code)");
  process.exit(0);
}
function option(name: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  const arg = process.argv[index];
  return arg === name ? process.argv[index + 1] : arg?.slice(name.length + 1);
}
const session = option("--session-id") ?? "fake-session";
const write = (data: unknown) => console.log(JSON.stringify(data));
const lines = createInterface({ input: process.stdin });
let id = 0;
let childText = false;
let preToolCallback: string | undefined;
let elicitationWaiting = false;
const configIndex = process.argv.indexOf("--mcp-config");
let mcp: Record<string, unknown> =
  configIndex >= 0
    ? object(
        object(JSON.parse(readPrivateMcpConfig(process.argv[configIndex + 1] ?? "")))["mcpServers"],
      )
    : {};
const ownedServers = [
  {
    name: "project-tools",
    source: "project",
    status: "connected",
    tools: [{ name: "read" }],
    future: 42,
  },
  { name: "plugin-tools", source: "plugin", status: "connected" },
];
for await (const line of lines) {
  const data = object(JSON.parse(line) as unknown);
  if (data["type"] === "control_request") {
    const request = object(data["request"]);
    if (request["subtype"] === "initialize") {
      childText = request["forwardSubagentText"] === true;
      const matcher = object(list(object(request["hooks"])["PreToolUse"])[0]);
      const callback = list(matcher["hookCallbackIds"])[0];
      preToolCallback = typeof callback === "string" ? callback : undefined;
    }
    write({
      type: "system",
      subtype: "fake_control",
      request,
      argv: process.argv,
      settings: {
        permissionMode: option("--permission-mode"),
        settingSources: (option("--setting-sources") ?? "").split(",").filter(Boolean),
        strictMcp: process.argv.includes("--strict-mcp-config"),
      },
    });
    if (
      request["subtype"] === "stop_task" &&
      request["task_id"] === process.env["ACE_FAKE_STOP_TASK"]
    ) {
      write({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: data["request_id"],
          error: "Synthetic stop failure",
        },
      });
      continue;
    }
    if (request["subtype"] === "mcp_set_servers") mcp = object(request["servers"]);
    write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: data["request_id"],
        response:
          request["subtype"] === "initialize"
            ? { commands: [], agents: [], models: [] }
            : request["subtype"] === "interrupt"
              ? { still_queued: [] }
              : request["subtype"] === "mcp_status"
                ? {
                    mcpServers: [
                      ...ownedServers,
                      ...Object.keys(mcp).map((name) => ({
                        name,
                        source: "dynamic",
                        status: "connected",
                      })),
                    ],
                  }
                : request["subtype"] === "mcp_set_servers"
                  ? {
                      added: Object.keys(mcp),
                      removed: [],
                      errors: "broken" in mcp ? { broken: "connection refused" } : {},
                      future: "retained",
                    }
                  : {},
      },
    });
    if (request["subtype"] === "mcp_status" && elicitationWaiting)
      write({
        type: "assistant",
        parent_tool_use_id: "waiting-child",
        session_id: session,
        message: {
          id: "waiting-progress",
          role: "assistant",
          content: [{ type: "text", text: "Progress while you decide" }],
        },
      });
    if (request["subtype"] === "interrupt")
      write({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [],
        terminal_reason: "aborted_streaming",
        session_id: session,
      });
  } else if (data["type"] === "user") {
    const message = object(data["message"]);
    const parts = list(message["content"]);
    const text = parts.map((p) => object(p)["text"] ?? "image").join(" ");
    write({ type: "system", subtype: "init", session_id: session, cwd: process.cwd() });
    write({ type: "system", subtype: "fake_input", input: data });
    if (text === "permission-gate" && preToolCallback) {
      write({
        type: "control_request",
        request_id: `hook-${++id}`,
        request: {
          subtype: "hook_callback",
          callback_id: preToolCallback,
          input: {
            hook_event_name: "PreToolUse",
            session_id: session,
            cwd: process.cwd(),
            transcript_path: "synthetic",
            tool_name: "Read",
            tool_input: { file_path: ".env" },
            tool_use_id: "tool-protected",
          },
        },
      });
      continue;
    }
    if (text === "crash") process.exit(3);
    if (text === "task-churn") {
      for (let n = 0; n < 2000; n++) {
        write({
          type: "system",
          subtype: "task_started",
          task_id: `finished-${n}`,
          tool_use_id: `spawn-${n}`,
          task_type: "local_agent",
        });
        write({
          type: "system",
          subtype: "task_notification",
          task_id: `finished-${n}`,
          status: "completed",
        });
      }
      write({
        type: "system",
        subtype: "task_started",
        task_id: "live-after-churn",
        tool_use_id: "live-spawn",
        task_type: "local_bash",
        is_backgrounded: true,
      });
    }
    if (text === "task-capacity") {
      for (let n = 0; n < 513; n++)
        write({
          type: "system",
          subtype: "task_started",
          task_id: `live-${n}`,
          task_type: "local_bash",
        });
    }
    if (text === "future") {
      console.log("malformed JSON");
      console.log("null");
      write({ type: "future_frame", novel: { value: 42 } });
    }
    if (text === "stream-probe") {
      if (process.argv.includes("--include-partial-messages")) {
        for (const event of [
          { type: "message_start", message: { id: "partial" } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "partial answer" },
          },
        ])
          write({
            type: "stream_event",
            event,
            parent_tool_use_id: null,
            uuid: `event-${++id}`,
            session_id: session,
          });
      }
      write({
        type: "system",
        subtype: "task_started",
        task_id: "child-text",
        tool_use_id: "spawn-text",
        task_type: "local_agent",
      });
      if (childText)
        write({
          type: "assistant",
          parent_tool_use_id: "spawn-text",
          message: {
            id: "child-text",
            role: "assistant",
            content: [{ type: "text", text: "child answer" }],
          },
          session_id: session,
        });
    }
    if (text === "completed-ancestor" || text === "late-descendant") {
      for (const [task_id, tool_use_id, parent] of [
        ["ancestor", "top", ""],
        ["middle", "middle-spawn", "top"],
        ["descendant", "leaf", "middle-spawn"],
      ]) {
        if (text === "late-descendant" && task_id === "descendant")
          write({
            type: "system",
            subtype: "task_notification",
            task_id: "middle",
            status: "completed",
          });
        write({
          type: "assistant",
          parent_tool_use_id: parent || null,
          message: {
            id: tool_use_id,
            role: "assistant",
            content: [{ type: "tool_use", id: tool_use_id, name: "Agent", input: {} }],
          },
        });
        write({
          type: "system",
          subtype: "task_started",
          task_id,
          tool_use_id,
          task_type: "local_agent",
        });
      }
      write({
        type: "system",
        subtype: "task_notification",
        task_id: "middle",
        status: "completed",
      });
      write({ type: "system", subtype: "ancestry-ready" });
    }
    if (text === "nested-tasks") {
      for (const [task_id, tool_use_id] of [
        ["child-one", "spawn-one"],
        ["grandchild", "spawn-two"],
      ])
        write({
          type: "system",
          subtype: "task_started",
          task_id,
          tool_use_id,
          task_type: "local_agent",
          is_backgrounded: true,
        });
      write({
        type: "assistant",
        parent_tool_use_id: "spawn-one",
        message: {
          id: "nested",
          role: "assistant",
          content: [
            { type: "tool_use", id: "spawn-two", name: "Agent", input: { prompt: "nested" } },
          ],
        },
      });
      write({ type: "system", subtype: "nested-ready" });
    }
    if (text === "tasks") {
      write({
        type: "system",
        subtype: "task_started",
        task_id: "child-one",
        tool_use_id: "spawn-one",
        task_type: "local_agent",
        is_backgrounded: true,
      });
      write({
        type: "system",
        subtype: "task_started",
        task_id: "shell-one",
        tool_use_id: "shell-tool",
        task_type: "local_bash",
        is_backgrounded: true,
      });
    }
    if (["form", "url", "elicitation-cancel", "dialog"].includes(text)) {
      const requestId = `request-${++id}`;
      elicitationWaiting = text !== "dialog";
      if (elicitationWaiting)
        write({
          type: "system",
          subtype: "task_started",
          task_id: "waiting-child-task",
          tool_use_id: "waiting-child",
          task_type: "local_agent",
        });
      write({
        type: "control_request",
        request_id: requestId,
        request:
          text === "dialog"
            ? { subtype: "request_user_dialog", dialog_kind: "future-kind", payload: {} }
            : {
                subtype: "elicitation",
                mcp_server_name: "project-tools",
                message: "Pick a color",
                mode: text === "url" ? "url" : "form",
                ...(text === "url"
                  ? { url: "https://example.test/consent", elicitation_id: "url-ask" }
                  : {
                      requested_schema: {
                        type: "object",
                        properties: { color: { type: "string" } },
                      },
                    }),
                title: "Consent",
                description: "From project MCP",
              },
      });
      if (text === "elicitation-cancel")
        write({ type: "control_cancel_request", request_id: requestId });
    } else if (
      [
        "approval",
        "permission-meta",
        "permission-suppressed",
        "question",
        "plan",
        "cancel",
      ].includes(text)
    ) {
      const tool =
        text === "question" ? "AskUserQuestion" : text === "plan" ? "ExitPlanMode" : "Edit";
      const input =
        tool === "AskUserQuestion"
          ? { questions: [{ question: "Tabs?", options: [{ label: "Tabs" }] }] }
          : tool === "ExitPlanMode"
            ? { plan: "# Plan", planFilePath: "plan.md" }
            : { file_path: "fake.ts" };
      const requestId = `request-${++id}`;
      write({
        type: "control_request",
        request_id: requestId,
        request: {
          subtype: "can_use_tool",
          tool_name: tool,
          input,
          tool_use_id: `tool-${id}`,
          permission_suggestions: [
            { type: "setMode", mode: "acceptEdits", destination: "session" },
            ...(text.startsWith("permission-")
              ? [
                  {
                    type: "addDirectories",
                    directories: ["/tmp/tools"],
                    destination: "projectSettings",
                  },
                ]
              : []),
          ],
          ...(text.startsWith("permission-")
            ? {
                title: "Claude wants to edit fake.ts",
                description: "Write access",
                default_to_no: true,
                suppress_always_allow_rule: text === "permission-suppressed",
                mcp_server: { name: "project-tools", source: "project" },
              }
            : {}),
          requires_user_interaction: tool !== "Edit",
        },
      });
      if (text === "cancel") write({ type: "control_cancel_request", request_id: requestId });
    } else
      write({
        type: "result",
        subtype: "success",
        is_error: false,
        terminal_reason: "completed",
        session_id: session,
      });
  } else if (data["type"] === "control_response") {
    elicitationWaiting = false;
    write({ type: "system", subtype: "fake_resolution", response: data["response"] });
    write({
      type: "result",
      subtype: "success",
      is_error: false,
      terminal_reason: "completed",
      session_id: session,
    });
  }
}
