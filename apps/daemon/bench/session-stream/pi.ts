/**
 * Synthetic Pi JSONL peer for the session bench (E3.0d). It answers the open handshake and
 * prints one turn per prompt, and it never imports or starts Pi.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

const Command = z.looseObject({ type: z.string(), id: z.string().optional() });
const Header = z.looseObject({ type: z.literal("session"), id: z.string() });

const home = process.env.FAKE_PI_HOME ?? "";
const source = join(home, "source.jsonl");
const header = Header.parse(JSON.parse(readFileSync(source, "utf8").split("\n")[0] ?? ""));
const extension = process.argv[process.argv.indexOf("-e") + 1] ?? "";
/** One turn: 2,000 assistant deltas, then the message's end and the turn's end. */
const DELTAS = 2_000;
const ANSWER = "bench answer";

function emit(data: unknown) {
  process.stdout.write(JSON.stringify(data) + "\n");
}
const reply = (command: z.infer<typeof Command>, data: unknown = {}) =>
  emit({ type: "response", id: command.id, command: command.type, success: true, data });

createInterface({ input: process.stdin }).on("line", (line) => {
  const command = Command.parse(JSON.parse(line));
  switch (command.type) {
    case "get_commands":
      reply(command, {
        commands: [{ name: "ace-rollback", source: "extension", sourceInfo: { path: extension } }],
      });
      return;
    case "get_state":
      reply(command, {
        sessionFile: source,
        sessionId: header.id,
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
      });
      return;
    case "prompt": {
      for (let index = 0; index < DELTAS; index++)
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tok " },
        });
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: ANSWER }],
          stopReason: "stop",
          usage: { input: 5, output: 3 },
        },
      });
      emit({ type: "agent_end", messages: [], willRetry: false });
      reply(command);
      return;
    }
    default:
      emit({
        type: "response",
        id: command.id,
        command: command.type,
        success: false,
        error: "Unknown synthetic command",
      });
  }
});
