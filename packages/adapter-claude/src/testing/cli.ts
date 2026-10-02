#!/usr/bin/env node
// Synthetic provider boundary. No model, auth service, or installed CLI is invoked.
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  console.log("2.1.286 (Claude Code)");
  process.exit(0);
}
const session = process.argv[process.argv.indexOf("--session-id") + 1] ?? "fake-session";
const write = (data: unknown) => console.log(JSON.stringify(data));
const lines = createInterface({ input: process.stdin });
let id = 0;
for await (const line of lines) {
  const data = JSON.parse(line) as Record<string, unknown>;
  if (data["type"] === "control_request") {
    const request = data["request"] as Record<string, unknown>;
    write({ type: "system", subtype: "fake_control", request });
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
              : {},
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
    const message = data["message"] as Record<string, unknown>;
    const parts = message["content"] as { type: string; text?: string }[];
    const text = parts.map((p) => p.text ?? "image").join(" ");
    write({ type: "system", subtype: "init", session_id: session, cwd: process.cwd() });
    write({ type: "system", subtype: "fake_input", input: data });
    if (text === "crash") process.exit(3);
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
    if (["approval", "question", "plan", "cancel"].includes(text)) {
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
          ],
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
