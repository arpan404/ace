/**
 * Codex for the session bench (E3-codex.5, E3.0d): the synthetic app-server and the provider that
 * drives it. Spawned with `--fake` it is the app-server; imported, it is the provider. It answers
 * the open handshake and prints one turn per prompt, and it never imports or starts a real CLI.
 */
import { createInterface } from "node:readline";
import type { ProviderSession, SessionContext } from "@ace/engine-api";
import type { BenchProvider, BenchTranslator } from "./provider.ts";

/** One turn: 2,000 agent message deltas, then the item's end and the turn's end. */
const DELTAS = 2_000;
/** The turn/start send, its started frame, the item, the completion and the reply. */
const SESSION_FRAMES = 5;

function send(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function runFake(): void {
  createInterface({ input: process.stdin }).on("line", (line) => {
    let frame: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    const id = frame.id;
    const params = frame.params ?? {};
    switch (frame.method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id,
          result: {
            userAgent: "ace/0.159.1",
            codexHome: "/fake",
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
        return;
      case "initialized":
        return;
      case "permissionProfile/list":
        send({
          jsonrpc: "2.0",
          id,
          result: {
            data: [
              { id: ":read-only", allowed: true },
              { id: ":workspace", allowed: true },
              { id: ":danger-full-access", allowed: true },
            ],
          },
        });
        return;
      case "config/read":
        send({
          jsonrpc: "2.0",
          id,
          result: { config: { default_permissions: ":workspace", approval_policy: "on-request" } },
        });
        return;
      case "thread/start":
      case "thread/resume":
      case "thread/fork":
        send({
          jsonrpc: "2.0",
          id,
          result: { thread: { id: "bench", cwd: params["cwd"] ?? "/fake", turns: [] } },
        });
        return;
      case "thread/settings/update":
      case "account/rateLimits/read":
        send({ jsonrpc: "2.0", id, result: {} });
        return;
      case "skills/list":
      case "app/list":
      case "mcpServerStatus/list":
      case "model/list":
        send({ jsonrpc: "2.0", id, result: { data: [] } });
        return;
      case "turn/start": {
        const turnId = "bench-turn";
        const threadId = String(params["threadId"] ?? "bench");
        send({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { threadId, turn: { id: turnId } },
        });
        for (let index = 0; index < DELTAS; index++)
          send({
            jsonrpc: "2.0",
            method: "item/agentMessage/delta",
            params: { threadId, turnId, itemId: "answer", delta: "tok " },
          });
        send({
          jsonrpc: "2.0",
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item: { id: "answer", type: "agentMessage", text: "bench answer", phase: "final_answer" },
          },
        });
        send({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed" } },
        });
        // The reply follows the turn's frames, as Pi's and ACP's fakes do: a send that resolves
        // then means every frame of that turn was written.
        send({ jsonrpc: "2.0", id, result: { turn: { id: turnId } } });
        return;
      }
      case "turn/steer":
        send({ jsonrpc: "2.0", id, result: {} });
        return;
      case "turn/interrupt":
        send({ jsonrpc: "2.0", id, result: {} });
        return;
      case "thread/backgroundTerminals/list":
        send({ jsonrpc: "2.0", id, result: { data: [] } });
        return;
      default:
        if (frame.method !== undefined)
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "Unsupported synthetic method" },
          });
    }
  });
}

/** This module's own path: the fake the adapter's spawn runs. */
const self = new URL(import.meta.url).pathname;

export const codex: BenchProvider = {
  id: "codex",
  // The app-server's 2,000 deltas and three turn frames, the turn/start send and its reply.
  framesPerTurn: DELTAS + SESSION_FRAMES,
  nativeExport: "CodexPoolNative",
  switches: (mode) => {
    switch (mode) {
      case "A":
        return {};
      case "B":
        return { ACE_TRANSLATORS: "codex" };
      case "C":
        return { ACE_TRANSLATORS: "codex", ACE_STORE: "native", ACE_SUPERVISOR: "native" };
      case "D":
        return {
          ACE_TRANSLATORS: "codex",
          ACE_STORE: "native",
          ACE_SUPERVISOR: "native",
          ACE_SESSIONS: "codex",
        };
    }
  },
  prepare: async () => {},
  env: () => ({}),
  prompt: (turn) => [{ type: "text", text: `bench turn ${turn}` }],
  translator: async (threadId): Promise<BenchTranslator> => {
    const [{ createCodexAdapter }, { ThreadId }] = await Promise.all([
      import("@ace/adapter-codex"),
      import("@ace/protocol"),
    ]);
    return createCodexAdapter().createTranslator({
      threadId: ThreadId.parse(threadId),
      rootKey: "root",
    }) as BenchTranslator;
  },
  session:
    () =>
    async (ctx: SessionContext): Promise<ProviderSession> => {
      const [{ createCodexAdapter }, { spawnSupervised }] = await Promise.all([
        import("@ace/adapter-codex"),
        import("@ace/provider-kit/process"),
      ]);
      const adapter = createCodexAdapter({
        cli: {
          installed: true,
          path: "synthetic-codex",
          version: "0.159.1",
          auth: "logged_in",
          loginHint: "none",
        },
        runtime: {
          spawn: (options) =>
            spawnSupervised({
              ...options,
              command: process.execPath,
              args: [self, "--fake", ...(options.args ?? [])],
            }),
        },
      });
      return adapter.openSession(ctx);
    },
};

if (process.argv.includes("--fake")) runFake();
