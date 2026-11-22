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
          // The fork's source: its first turn finishes, so the fork has a turn to start from.
          if (window === "fork-attempted" && operation === "first-command") {
            await frame(context, "send", { input, attemptedAt: Date.now() });
            await frame(context, "segment", { nativeRunId: "run-0" }, { runId: "run-0" });
            await frame(context, "result", { status: "finished" }, { runId: "run-0" });
            return;
          }
          if (window === "fork-attempted") {
            await frame(context, "send", { input, attemptedAt: Date.now() });
            return reached();
          }
          // The engine has recorded the submission; the host has stored nothing yet.
          if (window === "submitted") return reached();
          await frame(context, "send", { input, attemptedAt: Date.now() });
          if (window === "attempted") return reached();
          await frame(context, "segment", { nativeRunId: "run-1" }, { runId: "run-1" });
          await frame(
            context,
            "delta",
            { type: "text-delta", text: "before" },
            { runId: "run-1", eventSeq: 1 },
          );
          // A follow-up the person queued behind the running turn.
          if (window === "admitted-followup")
            engine.handler.handle(
              Command.parse({
                id: "follow-up",
                deviceId: "device",
                payload: {
                  type: "thread.send",
                  threadId: "crashed-thread",
                  delivery: "queue",
                  input: [{ type: "text", text: "follow-up" }],
                },
              }),
              store,
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
// A fork is the second thread: it is the one the parent checks after the crash.
const ids = window === "fork-attempted" ? ["source-thread", "crashed-thread"] : [];
const engine = new Engine(store, {
  registry,
  threadId: () => ids.shift() ?? "crashed-thread",
});
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
if (window === "fork-attempted") {
  await engine.flush();
  const finished = store
    .readEvents({ afterSeq: 0, limit: 1000 })
    .findLast((event) => event.payload.type === "run.ended");
  if (finished?.payload.type !== "run.ended") throw new Error("The fork's source never finished");
  const fork = engine.handler.handle(
    Command.parse({
      id: "fork-command",
      deviceId: "device",
      payload: {
        type: "thread.fork",
        threadId: "source-thread",
        point: { type: "turn", runId: finished.payload.runId },
        input: "forked",
        budgetBytes: 4096,
      },
    }),
    store,
  );
  if (!fork.ok) throw new Error(fork.error);
}
void engine.flush();
// The parent kills this process once the named point is committed, with no timed sleep.
process.on("message", () => {});
