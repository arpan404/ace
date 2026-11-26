/**
 * Pi for the session bench (E3-pi.2, E3.0d): the synthetic JSONL peer and the provider that
 * drives it. Spawned with `--fake` it is the peer; imported, it is the provider. It answers
 * the open handshake and prints one turn per prompt, and it never imports or starts Pi.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { writeFile } from "node:fs/promises";
import type { ProviderSession, SessionContext } from "@ace/engine-api";
import type { BenchProvider } from "./provider.ts";

const Command = z.looseObject({ type: z.string(), id: z.string().optional() });
const Header = z.looseObject({ type: z.literal("session"), id: z.string() });

/** One turn: 2,000 assistant deltas, then the message's end and the turn's end. */
const DELTAS = 2_000;
const ANSWER = "bench answer";

function emit(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

const reply = (command: z.infer<typeof Command>, data: unknown = {}) =>
  emit({ type: "response", id: command.id, command: command.type, success: true, data });

function runFake(): void {
  const home = process.env.FAKE_PI_HOME ?? "";
  const source = join(home, "source.jsonl");
  const header = Header.parse(JSON.parse(readFileSync(source, "utf8").split("\n")[0] ?? ""));
  const extension = process.argv[process.argv.indexOf("-e") + 1] ?? "";
  createInterface({ input: process.stdin }).on("line", (line) => {
    const command = Command.parse(JSON.parse(line));
    switch (command.type) {
      case "get_commands":
        reply(command, {
          commands: [
            { name: "ace-rollback", source: "extension", sourceInfo: { path: extension } },
          ],
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
}

/** This module's own path: the fake the adapter's spawn runs. */
const self = new URL(import.meta.url).pathname;

export const pi: BenchProvider = {
  id: "pi",
  // The prompt's send, 2,000 deltas, one message end, one turn end, the response.
  framesPerTurn: DELTAS + 2 + 1 + 1,
  nativeExport: "PiSessionNative",
  switches: (mode) => {
    switch (mode) {
      case "A":
        return {};
      case "B":
        return { ACE_TRANSLATORS: "pi" };
      case "C":
        return { ACE_TRANSLATORS: "pi", ACE_STORE: "native", ACE_SUPERVISOR: "native" };
      case "D":
        return {
          ACE_TRANSLATORS: "pi",
          ACE_STORE: "native",
          ACE_SUPERVISOR: "native",
          ACE_SESSIONS: "pi",
        };
    }
  },
  async prepare(home) {
    const { sessionFixture } =
      await import("../../../../packages/adapter-pi/src/testing/native-history.ts");
    // Pi's open reads the saved history's header, so the fake's get_state points at this file.
    await writeFile(join(home, "source.jsonl"), sessionFixture(home, "bench", 3));
  },
  env: (home) => ({ FAKE_PI_HOME: home }),
  prompt: (turn) => [{ type: "text", text: `bench turn ${turn}` }],
  translator: async (threadId) => {
    const [{ createPiTranslator }, { ThreadId }] = await Promise.all([
      import("@ace/adapter-pi"),
      import("@ace/protocol"),
    ]);
    return createPiTranslator({ threadId: ThreadId.parse(threadId), rootKey: "root" });
  },
  session:
    (home) =>
    async (ctx: SessionContext): Promise<ProviderSession> => {
      const [{ createPiAdapter }, { spawnTextSupervised }, { ThreadId }] = await Promise.all([
        import("@ace/adapter-pi"),
        import("@ace/provider-kit/process"),
        import("@ace/protocol"),
      ]);
      const adapter = createPiAdapter({
        sessionReferenceDir: join(home, "references"),
        cli: {
          installed: true,
          path: "synthetic-pi",
          version: "0.85.1",
          auth: "unknown",
          loginHint: "none",
        },
        runtime: {
          spawn: (options) =>
            spawnTextSupervised({
              ...options,
              command: process.execPath,
              args: [self, "--fake", ...(options.args ?? [])],
            }),
        },
      });
      void ThreadId;
      return adapter.openSession(ctx);
    },
};

if (process.argv.includes("--fake")) runFake();
