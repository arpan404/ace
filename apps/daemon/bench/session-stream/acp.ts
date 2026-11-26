/**
 * ACP for the session bench (E3-acp.3, E3.0d): the synthetic JSON-RPC agent and the provider
 * that drives it. Spawned with `--fake` it is the agent; imported, it is the provider. It
 * answers the open handshake and prints one turn per prompt, and it never imports or starts a
 * real CLI.
 */
import { createInterface } from "node:readline";
import type { ProviderSession, SessionContext } from "@ace/engine-api";
import type { BenchProvider } from "./provider.ts";

/** One turn: 2,000 agent message chunks, then the prompt's reply. */
const DELTAS = 2_000;
/** The queue's notes and the prompt's own frame join the agent's lines each turn. */
const SESSION_FRAMES = 3;

function send(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function runFake(): void {
  const sessionId = "bench-session";
  createInterface({ input: process.stdin }).on("line", (line) => {
    let message: {
      id?: unknown;
      method?: string;
      params?: { sessionId?: string };
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    switch (message.method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: "acp-bench", version: "1.0.0" },
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: false },
              mcpCapabilities: { http: false, sse: false },
            },
          },
        });
        return;
      case "session/new":
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            sessionId,
            modes: {
              currentModeId: "default",
              availableModes: [{ id: "default", name: "Default" }],
            },
          },
        });
        return;
      case "session/prompt": {
        for (let index = 0; index < DELTAS; index++)
          send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "tok " },
              },
            },
          });
        send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        return;
      }
      default:
        if (message.method !== undefined)
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Unsupported synthetic method" },
          });
    }
  });
}

/** This module's own path: the fake the adapter's spawn runs. */
const self = new URL(import.meta.url).pathname;

export const acp: BenchProvider = {
  id: "acp",
  // The agent's 2,000 chunks and its reply, plus the prompt's frame and the queue's two notes.
  framesPerTurn: DELTAS + 1 + SESSION_FRAMES,
  nativeExport: "AcpSessionNative",
  switches: (mode) => {
    switch (mode) {
      case "A":
        return {};
      case "B":
        return { ACE_TRANSLATORS: "acp" };
      case "C":
        return { ACE_TRANSLATORS: "acp", ACE_STORE: "native", ACE_SUPERVISOR: "native" };
      case "D":
        return {
          ACE_TRANSLATORS: "acp",
          ACE_STORE: "native",
          ACE_SUPERVISOR: "native",
          ACE_SESSIONS: "acp",
        };
    }
  },
  prepare: async () => {},
  env: () => ({}),
  prompt: (turn) => [{ type: "text", text: `bench turn ${turn}` }],
  translator: async (threadId) => {
    const [{ createAcpAdapter }, { ThreadId }] = await Promise.all([
      import("@ace/adapter-acp"),
      import("@ace/protocol"),
    ]);
    return createAcpAdapter().createTranslator({
      threadId: ThreadId.parse(threadId),
      rootKey: "root",
    });
  },
  session:
    () =>
    async (ctx: SessionContext): Promise<ProviderSession> => {
      const { createAcpAdapter } = await import("@ace/adapter-acp");
      const adapter = createAcpAdapter(undefined, {
        command: process.execPath,
        args: [self, "--fake"],
        env: {},
      });
      return adapter.openSession(ctx);
    },
};

if (process.argv.includes("--fake")) runFake();
