// Offline Cursor host fixture for a daemon that is killed mid-send. No provider is contacted.
// It speaks the host's frames in the host's order: the attempt (`send`) is committed before
// Cursor could see the input, then its admission (`segment`), then output. The parent kills
// this process at one of those points, named by the third argument, once it is committed.
import { Store } from "../store.ts";
import { Engine } from "./index.ts";
import { AdapterRegistry } from "./registry.ts";
import { CursorTranslator, cursorCapabilities } from "@ace/adapter-cursor";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { Command } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";

const [database, root, window] = process.argv.slice(2);
if (!database || !root || !window) throw new Error("Missing fixture arguments");
const store = new Store(database);
const workspace = store.createWorkspace(root, "Crash workspace");
const registry = new AdapterRegistry();
let operation = "open";
let seq = 0;
const frame = (context: SessionContext, kind: string, body: unknown, extra = {}) => {
  const payload = new ProviderPayload(
    JSON.stringify({
      schemaVersion: 1,
      generation: "before-crash",
      operationId: operation,
      commandId: operation,
      segment: 0,
      agentId: "native-agent",
      kind,
      body,
      ...extra,
    }),
  );
  return context.onFrame({
    seq: ++seq,
    t: seq,
    dir: kind === "send" ? "send" : "recv",
    channel: "sdk",
    data: payload.data,
    payload,
  });
};
const reached = () => {
  process.send?.({ reached: window });
  return new Promise<never>(() => {});
};
registry.register(
  {
    provider: "cursor",
    backend: "cursor-sdk",
    capabilities: () => cursorCapabilities,
    createTranslator: (init) => new CursorTranslator(init),
    async openSession(context) {
      context.onSessionIdentity?.({
        backend: "cursor-sdk",
        instanceId: "account-a",
        nativeSessionId: "native-agent",
      });
      await frame(context, "open", { cwd: root, model: "composer-2.5" });
      return {
        nativeSessionId: "native-agent",
        backend: "cursor-sdk",
        instanceId: "account-a",
        async send(input, _delivery, intent) {
          operation = intent ?? "first-command";
          // The engine has recorded the submission; the host has stored nothing yet.
          if (window === "submitted") return reached();
          await frame(context, "send", { input, attemptedAt: Date.now() });
          if (window === "attempted") return reached();
          await frame(context, "segment", { nativeRunId: "run-1" }, { runId: "run-1" });
          await frame(
            context,
            "delta",
            { type: "text-delta", text: "before" },
            { runId: "run-1", streamSeq: 1 },
          );
          return reached();
        },
        async interrupt() {},
        async resolve() {},
        async stopTask() {},
        async close() {},
      };
    },
  },
  { installed: true, auth: "logged_in", loginHint: "offline" },
);
const engine = new Engine(store, { registry, threadId: () => "crashed-thread" });
const command = Command.parse({
  id: "first-command",
  deviceId: "device",
  payload: {
    type: "thread.create",
    provider: "cursor",
    workspaceId: workspace,
    input: [{ type: "text", text: "first" }],
  },
});
const result = engine.handler.handle(command, store);
if (!result.ok) throw new Error(result.error);
void engine.flush();
// The parent kills this process once the named point is committed, with no timed sleep.
process.on("message", () => {});
