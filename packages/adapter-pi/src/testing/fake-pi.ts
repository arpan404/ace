/** Synthetic documented RPC peer. This executable never imports or starts Pi. */
import { createInterface } from "node:readline";
import { z } from "zod";
const Command = z.looseObject({ type: z.string(), id: z.string().optional() });
let session = "/synthetic/source.jsonl",
  queue = false;
const extension = process.argv[process.argv.indexOf("-e") + 1] ?? "";
function emit(data: unknown) {
  process.stdout.write(JSON.stringify(data) + "\n");
}
const reply = (c: z.infer<typeof Command>, data: unknown = {}) =>
  emit({ type: "response", id: c.id, command: c.type, success: true, data });
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const c = Command.parse(JSON.parse(line));
  switch (c.type) {
    case "get_commands":
      reply(c, {
        commands: process.env.FAKE_PI_EXTENSION_MISSING
          ? []
          : [{ name: "ace-rollback", source: "extension", sourceInfo: { path: extension } }],
      });
      return;
    case "get_state":
      reply(c, {
        sessionFile: session,
        sessionId: "native",
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: queue ? 1 : 0,
      });
      return;
    case "switch_session":
      if (process.env.FAKE_PI_CANCEL_SWITCH) {
        reply(c, { cancelled: true });
        return;
      }
      session = typeof c.sessionPath === "string" ? c.sessionPath : session;
      reply(c, { cancelled: false });
      return;
    case "clone":
    case "fork":
      if (process.env.FAKE_PI_CANCEL_FORK) {
        reply(c, { cancelled: true });
        return;
      }
      session = "/synthetic/fork.jsonl";
      reply(c, { cancelled: false, text: "original prompt" });
      return;
    case "clear_queue":
      queue = false;
      reply(c);
      return;
    case "abort":
      emit({
        type: "extension_ui_request",
        id: "abort-proof",
        method: "notify",
        message: queue ? "queue still live" : "queue cleared",
      });
      emit({ type: "agent_settled" });
      reply(c);
      return;
    case "abort_bash":
      reply(c);
      return;
    case "extension_ui_response":
      emit({
        type: "extension_ui_request",
        id: "answer-proof",
        method: "notify",
        message: JSON.stringify(c),
      });
      return;
    case "prompt": {
      const message = typeof c.message === "string" ? c.message : "";
      if (message.startsWith("/ace-rollback ")) {
        const parts = message.split(" ");
        if (!process.env.FAKE_PI_MISSING_ACK)
          emit({
            type: "extension_ui_request",
            id: "rollback-result",
            method: "notify",
            message: JSON.stringify({
              type: "ace_rollback",
              id: parts[3],
              success: !process.env.FAKE_PI_CANCEL_ROLLBACK,
            }),
          });
        reply(c);
        return;
      }
      emit({ type: "agent_start" });
      emit({
        type: "extension_ui_request",
        id: "input-proof",
        method: "notify",
        message: JSON.stringify(c),
      });
      if (message === "dialogs") {
        emit({
          type: "extension_ui_request",
          id: "select",
          method: "select",
          title: "Indent?",
          options: ["Tabs", "Spaces"],
        });
        emit({
          type: "extension_ui_request",
          id: "confirm",
          method: "confirm",
          title: "Continue?",
          message: "Choose yes or no",
        });
        emit({
          type: "extension_ui_request",
          id: "editor",
          method: "editor",
          title: "Edit",
          prefill: "first\nsecond",
        });
        emit({
          type: "extension_ui_request",
          id: "timed",
          method: "input",
          title: "Value",
          timeout: 25,
        });
      } else {
        const toolsIndex = process.argv.indexOf("--tools");
        const allowed =
          toolsIndex < 0 ? undefined : (process.argv[toolsIndex + 1] ?? "").split(",");
        const responseText =
          message === "write-proof"
            ? allowed?.includes("write") || !allowed
              ? "write available"
              : "write unavailable"
            : message === "env-proof"
              ? (process.env.ACE_PI_MCP_BEARER ?? "")
              : "hello\u2028world\u2029!";
        emit({ type: "message_start", message: { role: "assistant", content: [] } });
        emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: responseText,
          },
        });
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: responseText }],
            stopReason: "stop",
            usage: { input: 5, output: 3 },
          },
        });
      }
      if (message === "queued") queue = true;
      emit({ type: "agent_end", messages: [], willRetry: false });
      emit({ type: "agent_settled" });
      reply(c);
      return;
    }
    default:
      emit({
        type: "response",
        id: c.id,
        command: c.type,
        success: false,
        error: "Unknown synthetic command",
      });
  }
});
