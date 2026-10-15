/** Synthetic documented RPC peer. This executable never imports or starts Pi. */
import { privateMcpConfig, readPrivateMcpConfig } from "@ace/mcp-server";
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { NativeHistory } from "./native-history.ts";
import { registerAcePiExtension } from "../index.ts";
import { createPiExtensionHost } from "./extension-host.ts";
import { join } from "node:path";
import { z } from "zod";
const Command = z.looseObject({ type: z.string(), id: z.string().optional() });
const nativeSession = z
  .object({ controlSecret: z.string(), mcp: z.object({ bearer: z.string() }).optional() })
  .parse(JSON.parse(readPrivateMcpConfig(z.string().parse(process.env.ACE_PI_SESSION_FILE))));
const history = new NativeHistory();
if (process.env.FAKE_PI_HOME) history.load(join(process.env.FAKE_PI_HOME, "source.jsonl"));
let queue = false,
  inputDelivered = false;
let confirmFork: ((confirmed: boolean) => void) | undefined;
const extension = process.argv[process.argv.indexOf("-e") + 1] ?? "";
if (process.env.FAKE_PI_LOAD_FAILURE) {
  // As Pi does when an extension factory throws: say why on stderr, then exit before any RPC.
  process.stderr.write(
    `Error: Failed to load extension "${extension}": Failed to load extension: synthetic factory failure\n` +
      'Hint: Start without extensions using "pi -ne".\n',
  );
  process.exit(1);
}
/** Like Pi, list each `--skill` directory's `<name>/SKILL.md` skills by their frontmatter name. */
function skillNames(): string[] {
  const names: string[] = [];
  for (let at = 0; at < process.argv.length; at++) {
    if (process.argv[at] !== "--skill") continue;
    const root = process.argv[at + 1] ?? "";
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const text = readFileSync(join(root, entry.name, "SKILL.md"), "utf8");
      const name = /^name:\s*(\S+)/m.exec(text)?.[1];
      if (name) names.push(name);
    }
  }
  return names;
}
function emit(data: unknown) {
  process.stdout.write(JSON.stringify(data) + "\n");
}
const reply = (c: z.infer<typeof Command>, data: unknown = {}) =>
  emit({ type: "response", id: c.id, command: c.type, success: true, data });
const approvals = new Map<string, (confirmed: boolean) => void>();
let approvalId = 0;
// This RPC peer exercises control hooks; it never opens a real MCP connection. Like ace's own
// session file, it lives as long as the process.
const controlConfig = privateMcpConfig(
  JSON.stringify({ controlSecret: nativeSession.controlSecret }),
  process.cwd(),
);
process.on("exit", controlConfig.remove);
// The extension sees one environment for the process, as it sees Pi's process.env.
const extensionEnv: NodeJS.ProcessEnv = {
  ACE_PI_SESSION_FILE: controlConfig.path,
  ACE_PI_PERMISSION_MODE: process.env.ACE_PI_PERMISSION_MODE,
};
/**
 * Like real Pi, the host rejects action calls made while the extension factory runs, and every
 * session replacement (switch_session, fork, clone) shuts the old runtime down and runs the
 * extension factory again in a new one.
 */
async function loadExtension() {
  const next = createPiExtensionHost({
    appendEntry(customType, data) {
      emit({ type: "entry_appended", entry: history.append(customType, data) });
    },
  });
  await next.start((pi) => registerAcePiExtension(pi, extensionEnv));
  return next;
}
let host = await loadExtension();
async function replaceRuntime() {
  await host.shutdown();
  host = await loadExtension();
}
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
          : [...host.commands.keys()].map((name) => ({
              name,
              source: "extension",
              sourceInfo: { path: extension },
            })),
      });
      return;
    case "get_state":
      reply(c, {
        sessionFile: process.env.FAKE_PI_UNSAVED
          ? join(process.env.FAKE_PI_HOME ?? "", "unsaved.jsonl")
          : history.path,
        sessionId: process.env.FAKE_PI_WRONG_ID ? "wrong-native-id" : history.id,
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: queue ? 1 : 0,
      });
      return;
    case "get_entries":
      if (process.env.FAKE_PI_BAD_ENTRIES === "cycle")
        reply(c, { entries: [{ type: "custom", id: "loop", parentId: "loop" }], leafId: "loop" });
      else if (process.env.FAKE_PI_BAD_ENTRIES === "oversized")
        reply(c, {
          entries: Array.from({ length: 4097 }, (_, i) => ({
            type: "custom",
            id: `entry-${i}`,
            parentId: null,
          })),
          leafId: null,
        });
      else reply(c, history.entriesResponse());
      return;
    case "switch_session":
      if (process.env.FAKE_PI_CANCEL_SWITCH) {
        reply(c, { cancelled: true });
        return;
      }
      if (typeof c.sessionPath === "string") history.load(c.sessionPath);
      await replaceRuntime();
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
        process.env.FAKE_PI_DEFER_CLONE === "1",
      );
      await replaceRuntime();
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
      approvals.get(c.id ?? "")?.(c.confirmed === true);
      approvals.delete(c.id ?? "");
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
          message: nativeSession.controlSecret,
        });
        process.stderr.write(`control=${nativeSession.controlSecret}\n`);
        const command = host.commands.get("ace-rollback");
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
      if (message === "gated-write" || message === "gated-shell") {
        const hook = host.handlers("tool_call").at(-1);
        const path = join(process.env.FAKE_PI_HOME ?? "", "approved.txt");
        const toolName = message === "gated-shell" ? "bash" : "write";
        const toolInput =
          toolName === "bash"
            ? { command: `printf approved >> ${path}` }
            : { path, content: "approved" };
        emit({
          type: "tool_execution_start",
          toolCallId: "write-call",
          toolName,
          args: toolInput,
        });
        const reviewed: Promise<unknown> =
          typeof hook === "function"
            ? Reflect.apply(hook, undefined, [
                {
                  toolName: process.env.FAKE_PI_MALFORMED_TOOL ? "x".repeat(1025) : toolName,
                  toolCallId: "write-call",
                  input: toolInput,
                },
                {
                  cwd: process.env.FAKE_PI_HOME,
                  hasUI: !process.env.FAKE_PI_NO_UI,
                  ui: {
                    confirm(title: string, approvalMessage: string) {
                      if (process.env.FAKE_PI_APPROVAL_FAILURE)
                        throw new Error("synthetic confirmation failure");
                      const id = `tool-approval-${++approvalId}`;
                      emit({
                        type: "extension_ui_request",
                        id,
                        method: "confirm",
                        title,
                        message: approvalMessage,
                      });
                      return new Promise<boolean>((resolve) => approvals.set(id, resolve));
                    },
                  },
                },
              ])
            : Promise.resolve({ block: false });
        reply(c);
        const decision = z
          .object({ block: z.boolean().optional() })
          .optional()
          .parse(await reviewed);
        if (!decision?.block) {
          if (toolName === "bash")
            await promisify(execFile)("sh", ["-c", 'printf approved >> "$1"', "ace-qa", path]);
          else await writeFile(path, "approved");
        }
        emit({
          type: "tool_execution_end",
          toolCallId: "write-call",
          toolName,
          isError: decision?.block === true,
          result: {
            content: [
              {
                type: "text",
                text: decision?.block ? "gated write denied" : "gated write completed",
              },
            ],
          },
        });
        emit({ type: "agent_settled" });
        return;
      }
      if (message === "unanswerable-dialog") {
        // A blocking dialog without an id can never be answered.
        emit({ type: "extension_ui_request", id: "", method: "select", options: ["a"] });
      } else if (message === "many-dialogs") {
        for (let index = 0; index < 200; index++)
          emit({
            type: "extension_ui_request",
            id: `many-${index}`,
            method: "confirm",
            title: "Continue?",
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
          message === "skills-proof"
            ? JSON.stringify({ skills: skillNames() })
            : message === "tools-proof"
              ? JSON.stringify({
                  tools: allowed ?? "all",
                  ambientExtensions: !process.argv.includes("--no-extensions"),
                })
              : message === "write-proof"
                ? allowed?.includes("write") || !allowed
                  ? "write available"
                  : "write unavailable"
                : message === "env-proof"
                  ? (nativeSession.mcp?.bearer ?? "")
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
