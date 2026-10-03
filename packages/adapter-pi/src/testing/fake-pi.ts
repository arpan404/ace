/** Synthetic documented RPC peer. This executable never imports or starts Pi. */
import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { NativeHistory } from "./native-history.ts";
import { registerAcePiExtension, type PiExtensionApi } from "../index.ts";
import { join } from "node:path";
import { z } from "zod";
const Command = z.looseObject({ type: z.string(), id: z.string().optional() });
const history = new NativeHistory();
if (process.env.FAKE_PI_HOME) history.load(join(process.env.FAKE_PI_HOME, "source.jsonl"));
let queue = false,
  inputDelivered = false;
let confirmFork: ((confirmed: boolean) => void) | undefined;
const extension = process.argv[process.argv.indexOf("-e") + 1] ?? "";
function emit(data: unknown) {
  process.stdout.write(JSON.stringify(data) + "\n");
}
const reply = (c: z.infer<typeof Command>, data: unknown = {}) =>
  emit({ type: "response", id: c.id, command: c.type, success: true, data });
const commands = new Map<string, Parameters<PiExtensionApi["registerCommand"]>[1]>();
await registerAcePiExtension(
  {
    registerCommand(name, command) {
      commands.set(name, command);
    },
    appendEntry(customType, data) {
      emit({ type: "entry_appended", entry: history.append(customType, data) });
    },
    registerTool() {},
    on() {},
  },
  { ACE_PI_CONTROL_SECRET: process.env.ACE_PI_CONTROL_SECRET },
);
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  void handle(line);
});
async function handle(line: string) {
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
        sessionFile: history.path,
        sessionId: process.env.FAKE_PI_WRONG_ID ? "wrong-native-id" : history.id,
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
      if (typeof c.sessionPath === "string") history.load(c.sessionPath);
      reply(c, { cancelled: false });
      return;
    case "clone":
    case "fork":
      if (process.env.FAKE_PI_FORK_DIALOG) {
        const answer = new Promise<boolean>((resolve) => {
          confirmFork = resolve;
        });
        emit({
          type: "extension_ui_request",
          id: "fork-confirm",
          method: "confirm",
          title: "Fork?",
          message: "Confirm native fork",
        });
        if (!(await answer)) {
          reply(c, { cancelled: true });
          return;
        }
      }
      if (
        process.env.FAKE_PI_COLD_CWD &&
        (process.cwd() !== realpathSync(process.env.FAKE_PI_COLD_CWD) || inputDelivered)
      ) {
        emit({
          type: "response",
          id: c.id,
          command: c.type,
          success: false,
          error: "Cold fork received input or wrong cwd",
        });
        return;
      }
      if (process.env.FAKE_PI_CANCEL_FORK) {
        reply(c, { cancelled: true });
        return;
      }
      history.clone(
        join(process.env.FAKE_PI_HOME ?? process.env.FAKE_PI_COLD_CWD ?? history.cwd, "fork.jsonl"),
        typeof c.entryId === "string" ? c.entryId : undefined,
      );
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
      if (c.id === "fork-confirm") {
        confirmFork?.(c.confirmed === true);
        confirmFork = undefined;
      }
      emit({
        type: "extension_ui_request",
        id: "answer-proof",
        method: "notify",
        message: JSON.stringify(c),
      });
      return;
    case "prompt": {
      inputDelivered = true;
      const message = typeof c.message === "string" ? c.message : "";
      if (message.startsWith("/ace-rollback ")) {
        emit({
          type: "extension_ui_request",
          id: "control-echo",
          method: "notify",
          message: process.env.ACE_PI_CONTROL_SECRET,
        });
        process.stderr.write(`control=${process.env.ACE_PI_CONTROL_SECRET}\n`);
        const command = commands.get("ace-rollback");
        if (!command) throw new Error("Missing synthetic control command");
        await command.handler(message.slice("/ace-rollback ".length), {
          async waitForIdle() {},
          async navigateTree(id) {
            if (process.env.FAKE_PI_CANCEL_ROLLBACK) return { cancelled: true };
            history.navigate(id);
            return { cancelled: false };
          },
          ui: {
            notify(notification) {
              if (!process.env.FAKE_PI_MISSING_ACK)
                emit({
                  type: "extension_ui_request",
                  id: "rollback-result",
                  method: "notify",
                  message: notification,
                });
            },
          },
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
      if (message === "large-dialog") {
        emit({
          type: "extension_ui_request",
          id: "large",
          method: "select",
          options: Array.from({ length: 257 }, (_, index) => String(index)),
        });
      } else if (message === "dialogs") {
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
              : message === "context-proof"
                ? history.context()
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
}
