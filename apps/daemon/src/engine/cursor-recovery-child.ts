// Offline SDK boundary fixture. No provider is imported or contacted.
import { Store } from "../store.ts";
import { Engine } from "./index.ts";
import { AdapterRegistry } from "./registry.ts";
import { CursorJournal, CursorTranslator, cursorCapabilities } from "@ace/adapter-cursor";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { Command } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";

const database = process.argv[2];
const root = process.argv[3];
if (!database || !root) throw new Error("Missing fixture paths");
const store = new Store(database);
const workspace = store.createWorkspace(root, "Crash workspace");
const journal = new CursorJournal(root, 65536, 4096);
await journal.recover(0, async () => {});
const registry = new AdapterRegistry();
let operation = "open";
const frame = async (context: SessionContext, kind: string, body: unknown, delivered = true) => {
  const envelope = await journal.append({
    schemaVersion: 1,
    generation: "before-crash",
    operationId: operation,
    commandId: operation,
    segment: 0,
    agentId: "native-agent",
    kind,
    body,
  });
  if (!delivered) return;
  const payload = new ProviderPayload(JSON.stringify(envelope));
  context.onFrame({
    seq: (envelope.boundaryOffset ?? 0) * 1024,
    t: 1,
    dir: kind === "send" ? "send" : "recv",
    channel: "sdk",
    data: payload.data,
    payload,
  });
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
          await frame(context, "send", { input });
          await frame(context, "delta", { type: "text-delta", text: "before" });
          await frame(context, "delta", { type: "text-delta", text: " after" }, false);
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
await engine.flush();
process.send?.({ ready: true });
// Parent kills this process at an explicit committed boundary, with no timed sleep.
process.on("message", () => {});
